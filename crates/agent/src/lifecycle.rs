//! Local lifecycle only: no enrollment, Desktop, command payload or transport dependency.
use central_sos_link::session::{ErrorCode, Identity, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Starting,
    Available,
    Unavailable(ErrorCode),
    Backoff,
    RepeatedFailure,
    Quarantined,
    Stopped,
}
pub enum Health {
    Ready,
    Busy,
    Starting,
    Exited,
}
pub trait Platform {
    type Child;
    fn discover(&mut self) -> Result<Identity>;
    fn launch(&mut self, identity: &Identity) -> Result<Self::Child>;
    fn health(&mut self, child: &Self::Child) -> Result<Health>;
    /// Must validate held handle, identity, image and ownership before terminating.
    fn retire(&mut self, child: &Self::Child) -> Result<()>;
    fn available(&mut self, child: Option<&Self::Child>);
}
pub struct Supervisor<P: Platform> {
    pub platform: P,
    pub state: State,
    child: Option<P::Child>,
    identity: Option<Identity>,
    failures: u32,
    retry_at: u64,
    started_at: u64,
    probe_at: u64,
    ready_at: u64,
    stopped: bool,
}
impl<P: Platform> Supervisor<P> {
    pub fn new(platform: P) -> Self {
        Self {
            platform,
            state: State::Starting,
            child: None,
            identity: None,
            failures: 0,
            retry_at: 0,
            started_at: 0,
            probe_at: 0,
            ready_at: 0,
            stopped: false,
        }
    }
    fn retire(&mut self) -> bool {
        self.platform.available(None);
        if let Some(child) = &self.child {
            if self.platform.retire(child).is_err() {
                // Retain the owned resource and refuse new launches. Never terminate a foreign peer.
                self.state = State::Quarantined;
                return false;
            }
        }
        self.child = None;
        true
    }
    fn failed(&mut self, now: u64, code: ErrorCode) {
        if !self.retire() {
            return;
        }
        self.failures = self.failures.saturating_add(1);
        let delay = if self.failures >= 5 {
            300_000
        } else {
            2_000 << (self.failures - 1)
        };
        self.retry_at = now.saturating_add(delay);
        self.state = if self.failures >= 5 {
            State::RepeatedFailure
        } else {
            State::Unavailable(code)
        };
    }
    pub fn tick(&mut self, now: u64) {
        if self.stopped || self.state == State::Quarantined {
            return;
        }
        let identity = match self.platform.discover() {
            Ok(identity) => identity,
            Err(error) => {
                if self.retire() {
                    self.identity = None;
                    self.state = State::Unavailable(error.code);
                }
                return;
            }
        };
        if identity.session_id == 0
            || identity.user_sid == "S-1-5-18"
            || !identity.user_sid.starts_with("S-1-")
            || !identity.logon_sid.starts_with("S-1-5-5-")
        {
            if self.retire() {
                self.state = State::Unavailable(ErrorCode::SessionPeerRejected);
            }
            return;
        }
        if self.identity.as_ref() != Some(&identity) {
            if !self.retire() {
                return;
            }
            self.identity = Some(identity.clone());
            self.failures = 0;
            self.retry_at = now;
        }
        if self.child.is_none() {
            if now < self.retry_at {
                self.state = if self.failures >= 5 {
                    State::RepeatedFailure
                } else {
                    State::Backoff
                };
                return;
            }
            match self.platform.launch(&identity) {
                Ok(child) => {
                    self.child = Some(child);
                    self.started_at = now;
                    self.probe_at = now;
                    self.state = State::Starting;
                }
                Err(error) => {
                    self.failed(now, error.code);
                    return;
                }
            }
        }
        if now < self.probe_at {
            return;
        }
        match self.platform.health(self.child.as_ref().unwrap()) {
            Ok(Health::Ready) => {
                self.platform.available(self.child.as_ref());
                self.state = State::Available;
                self.ready_at = now;
                if now.saturating_sub(self.started_at) >= 60_000 {
                    self.failures = 0;
                }
                self.probe_at = now.saturating_add(15_000);
            }
            Ok(Health::Busy) => {
                let (since, limit) = if self.state == State::Starting {
                    (self.started_at, 10_000)
                } else {
                    (self.ready_at, 45_000)
                };
                if now.saturating_sub(since) >= limit {
                    self.failed(now, ErrorCode::SessionTimeout);
                } else {
                    self.probe_at = now.saturating_add(1_000);
                }
            }
            Ok(Health::Starting) if now.saturating_sub(self.started_at) < 10_000 => {
                self.probe_at = now.saturating_add(1_000);
            }
            Ok(Health::Starting | Health::Exited) => {
                self.failed(now, ErrorCode::SessionHelperUnavailable)
            }
            Err(error) => self.failed(now, error.code),
        }
    }
    pub fn shutdown(&mut self) {
        self.stopped = true;
        if self.retire() {
            self.state = State::Stopped;
        }
    }
}

#[cfg(windows)]
mod native;
#[cfg(windows)]
pub use native::{exchange, invalidate, supervise, wake};
#[cfg(test)]
mod tests;
