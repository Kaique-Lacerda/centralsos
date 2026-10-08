use super::*;

struct FakeJob {
    limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    queries: usize,
    writes: usize,
    fail_query: Option<usize>,
    fail_set: bool,
    ignore_write: bool,
}
impl FakeJob {
    fn new() -> Self {
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        limits.ProcessMemoryLimit = 123456;
        Self {
            limits,
            queries: 0,
            writes: 0,
            fail_query: None,
            fail_set: false,
            ignore_write: false,
        }
    }
}
impl JobLimits for FakeJob {
    fn query(&mut self) -> std::result::Result<JOBOBJECT_EXTENDED_LIMIT_INFORMATION, ()> {
        self.queries += 1;
        if self.fail_query == Some(self.queries) {
            Err(())
        } else {
            Ok(self.limits)
        }
    }
    fn set(
        &mut self,
        limits: &JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    ) -> std::result::Result<(), ()> {
        self.writes += 1;
        if self.fail_set {
            return Err(());
        }
        if !self.ignore_write {
            self.limits = *limits;
        }
        Ok(())
    }
}

#[test]
fn quarantine_disarms_only_kill_on_close_and_confirms_without_weakening_other_limits() {
    let mut job = FakeJob::new();
    release_handles(false, false, false, &mut job).unwrap();
    assert_eq!(job.queries, 2);
    assert_eq!(job.writes, 1);
    assert_eq!(
        job.limits.BasicLimitInformation.LimitFlags,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY
    );
    assert_eq!(job.limits.BasicLimitInformation.ActiveProcessLimit, 1);
    assert_eq!(job.limits.ProcessMemoryLimit, 123456);
}
#[test]
fn failure_to_query_set_or_confirm_retains_all_handles_without_termination_fallback() {
    for failure in [
        DisarmFailure::Query,
        DisarmFailure::Set,
        DisarmFailure::Confirm,
    ] {
        let mut job = FakeJob::new();
        match failure {
            DisarmFailure::Query => job.fail_query = Some(1),
            DisarmFailure::Set => job.fail_set = true,
            DisarmFailure::Confirm => job.fail_query = Some(2),
        }
        let closed = Cell::new(false);
        assert_eq!(
            finish_release(release_handles(false, false, true, &mut job), || closed
                .set(true)),
            Err(failure)
        );
        assert!(
            !closed.get(),
            "no process/job/image pin may close on failed quarantine"
        );
        if failure == DisarmFailure::Query {
            assert_eq!(job.writes, 0);
        }
    }
}
#[test]
fn successful_api_return_with_kill_bit_still_set_is_not_trusted() {
    let mut job = FakeJob::new();
    job.ignore_write = true;
    let closed = Cell::new(false);
    assert_eq!(
        finish_release(release_handles(false, false, true, &mut job), || closed
            .set(true)),
        Err(DisarmFailure::Confirm)
    );
    assert!(!closed.get());
}
#[test]
fn drop_retries_failed_disarm_and_releases_only_after_confirmed_success() {
    let mut job = FakeJob::new();
    job.fail_set = true;
    assert_eq!(disarm_job(&mut job), Err(DisarmFailure::Set));
    job.fail_set = false;
    let closed = Cell::new(false);
    finish_release(release_handles(false, false, true, &mut job), || {
        closed.set(true)
    })
    .unwrap();
    assert!(closed.get());
    assert_eq!(job.writes, 2);
    assert_eq!(
        job.limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        0
    );
}
#[test]
fn confirmed_disarm_is_idempotent_and_quarantine_cannot_be_bypassed_by_new_identity_verification() {
    let mut job = FakeJob::new();
    disarm_job(&mut job).unwrap();
    release_handles(false, true, true, &mut job).unwrap();
    assert_eq!(job.writes, 1);
    let mut armed = FakeJob::new();
    release_handles(false, true, true, &mut armed).unwrap();
    assert_eq!(
        armed.writes, 1,
        "quarantined child cannot regain kill-on-close authorization"
    );
}
#[test]
fn verified_child_or_exited_process_releases_without_changing_job_limits() {
    for (exited, verified, quarantined) in [(false, true, false), (true, false, true)] {
        let mut job = FakeJob::new();
        let closed = Cell::new(false);
        finish_release(
            release_handles(exited, verified, quarantined, &mut job),
            || closed.set(true),
        )
        .unwrap();
        assert!(closed.get());
        assert_eq!((job.queries, job.writes), (0, 0));
    }
}
#[test]
fn abrupt_supervisor_exit_can_still_trigger_kernel_kill_when_disarm_failed() {
    let mut job = FakeJob::new();
    job.fail_set = true;
    assert_eq!(
        release_handles(false, false, true, &mut job),
        Err(DisarmFailure::Set)
    );
    // OS last-handle teardown is outside Rust Drop; retention only delays that event.
    assert_ne!(
        job.limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        0
    );
}
