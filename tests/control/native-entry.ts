// A single test bundle preserves instanceof identity across the real HTTP/service layers.
export { NativeAuthentication, proofChallenge } from '../../server/control/NativeAuthentication.js';
export { PostgresNativeAuthRepository, emptyNativeState } from '../../server/control/NativeAuthRepository.js';
export { ControlAuthentication } from '../../server/control/Authentication.js';
export { handleControlApi } from '../../server/control/HttpApi.js';
export { ControlBackend } from '../../server/control/ControlBackend.js';
export { MemoryRepository } from '../../server/control/Repository.js';
