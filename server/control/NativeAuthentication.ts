import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { ApiError, digest } from './ControlBackend.js';
import { nativeStartSchema, nativePollSchema, nativeCompleteSchema, nativeConfirmSchema, validateControlOrigin } from '../../packages/contracts/control/NativeAuthentication.js';
import type { NativeAuthErrorCode, NativeAuthorizationStart, NativeAuthorizationStatus, NativeSessionCredential, NativeSession } from '../../packages/contracts/control/NativeAuthentication.js';
import type { NativeAuthRepository, NativeStore, NativeTransaction } from './NativeAuthRepository.js';
import type { Actor } from './Repository.js';

export class NativeAuthError extends ApiError {
    constructor(public code: NativeAuthErrorCode, status: number, message: string) { super(status, message); }
}
function reject(code: NativeAuthErrorCode, status: number, message: string): never { throw new NativeAuthError(code, status, message); }
const randomToken = () => randomBytes(32).toString('base64url');
export const proofChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const equal = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
export interface NativeOidc {
    authorizationUrl(state: string, verifier: string, nonce: string, callbackPath: string): Promise<string>;
    exchangeSubject(code: string, verifier: string, nonceHash: string, callbackPath: string): Promise<string>;
}
const TTL = 5 * 60000, SESSION_TTL = 8 * 3600000, INTERVAL = 5;

export class NativeAuthentication {
    readonly origin: string;
    private key: Buffer;
    constructor(private repository: NativeAuthRepository, private oidc: NativeOidc, origin: string, secret: string, private now = () => Date.now()) {
        this.origin = validateControlOrigin(origin);
        if (secret.length < 32) throw new Error('Native authentication requires a backend session secret');
        this.key = createHash('sha256').update('central-sos-native-oidc:' + secret).digest();
    }
    private async state<T>(work: (store: NativeStore) => Promise<T>): Promise<T> {
        try {
            const result = await this.repository.transaction(async store => {
                const now = this.now();
                store.state.transactions = store.state.transactions.filter(t => t.expires + TTL > now);
                store.state.sessions = store.state.sessions.filter(s => s.expires + SESSION_TTL > now);
                store.state.limits = store.state.limits.filter(l => l.window >= Math.floor(now / 60000) - 1);
                // Commit expected denials too: failed proof/poll counters must survive replicas.
                try { return { value: await work(store) }; }
                catch (error) { if (error instanceof NativeAuthError) return { error }; throw error; }
                finally { store.state.audit = store.state.audit.slice(-1000); }
            });
            if ('error' in result) throw result.error;
            return result.value;
        } catch (error) {
            if (error instanceof NativeAuthError) throw error;
            return reject('BACKEND_UNAVAILABLE', 503, 'Autenticação indisponível. Tente novamente mais tarde.');
        }
    }
    async limit(peer: string, bucket: string, maximum: number) {
        return this.state(async ({ state }) => {
            const hash = digest(bucket + ':' + peer), window = Math.floor(this.now() / 60000);
            let row = state.limits.find(l => l.hash === hash);
            if (!row) { if (state.limits.length >= 10000) reject('RATE_LIMITED',429,'Aguarde antes de tentar novamente.'); row = { hash, window, attempts: 0 }; state.limits.push(row); }
            if (row.window !== window) { row.window = window; row.attempts = 0; }
            if (++row.attempts > maximum) reject('RATE_LIMITED',429,'Aguarde antes de tentar novamente.');
        });
    }
    private parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, input: unknown): T {
        const parsed = schema.safeParse(input);
        if (!parsed.success) return reject('INVALID_REQUEST',400,'Contrato de autenticação inválido.');
        return parsed.data;
    }
    private transaction(store: NativeStore, id: string) {
        const transaction = store.state.transactions.find(t => t.id === id);
        if (!transaction) return reject('INVALID_TRANSACTION',400,'Transação inválida.');
        if (transaction.consumed) return reject('TRANSACTION_CONSUMED',409,'Transação já consumida. Inicie outro login.');
        if (transaction.expires <= this.now()) return reject('TRANSACTION_EXPIRED',410,'Login expirado. Inicie outro login.');
        return transaction;
    }
    private proof(transaction: NativeTransaction, code: string, verifier: string) {
        if (transaction.failures >= 5) reject('RATE_LIMITED',429,'Transação bloqueada. Inicie outro login.');
        if (!equal(transaction.deviceHash, digest(code)) || !equal(transaction.challenge, proofChallenge(verifier))) {
            transaction.failures++;
            reject('PROOF_INVALID',401,'Prova de posse inválida.');
        }
    }
    private async actor(store: NativeStore, subject: string): Promise<Actor> {
        const actor = await store.actor(subject);
        if (!actor) return reject('OPERATOR_DISABLED',403,'Operador não habilitado.');
        if (!actor.memberships.length) return reject('MEMBERSHIP_REQUIRED',403,'Operador sem vínculo autorizado.');
        return actor;
    }
    private cipher(value: string) {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
        const encrypted = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
        return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
    }
    private decipher(value: string) {
        const packed = Buffer.from(value,'base64url'), cipher = createDecipheriv('aes-256-gcm',this.key,packed.subarray(0,12));
        cipher.setAuthTag(packed.subarray(12,28));
        return Buffer.concat([cipher.update(packed.subarray(28)),cipher.final()]).toString('utf8');
    }
    async start(input: unknown): Promise<NativeAuthorizationStart> {
        const request = this.parse(nativeStartSchema,input), deviceCode = randomToken();
        return this.state(async store => {
            if (store.state.transactions.length >= 1000) reject('RATE_LIMITED',429,'Login temporariamente indisponível.');
            let code: string;
            do { code = randomBytes(6).toString('hex').toUpperCase().match(/.{4}/g)!.join('-'); } while (store.state.transactions.some(t => t.code === code));
            const transaction: NativeTransaction = { id: randomUUID(),deviceHash:digest(deviceCode),code,challenge:request.codeChallenge,expires:this.now()+TTL,consumed:false,polls:0,failures:0,lastPoll:0,subject:null,approved:false };
            store.state.transactions.push(transaction);
            return { protocolVersion:1,transactionId:transaction.id,deviceCode,userCode:code,authorizationUrl:this.origin+'/api/control/auth/native/authorize?user_code='+code,expiresAt:new Date(transaction.expires).toISOString(),intervalSeconds:INTERVAL };
        });
    }
    async authorize(code: string) {
        if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(code)) reject('INVALID_TRANSACTION',400,'Código de conferência inválido.');
        const stateToken = randomToken(), browser = randomToken(), verifier = randomToken(), nonce = randomToken();
        const id = await this.state(async store => {
            const found = store.state.transactions.find(t => t.code === code);
            const tx = this.transaction(store, found?.id ?? '');
            if (tx.oidc || tx.browser) reject('TRANSACTION_CONSUMED',409,'Autorização já iniciada. Inicie outro login.');
            tx.oidc = { stateHash:digest(stateToken),browserHash:digest(browser),verifierCipher:this.cipher(verifier),nonceHash:digest(nonce),used:false };
            return tx.id;
        });
        try { return { id, browser, url: await this.oidc.authorizationUrl(stateToken,verifier,nonce,'/api/control/auth/native/callback') }; }
        catch { return reject('BACKEND_UNAVAILABLE',503,'Provedor de autenticação indisponível. Inicie outro login.'); }
    }
    async callback(stateToken: string, code: string, browser: string) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(stateToken) || !/^[A-Za-z0-9_-]{43}$/.test(browser) || !code || code.length>4096) reject('INVALID_REQUEST',401,'Retorno de login inválido.');
        const saved = await this.state(async store => {
            const found = store.state.transactions.find(t => t.oidc?.stateHash === digest(stateToken));
            const tx = this.transaction(store,found?.id??'');
            if (!tx.oidc || tx.oidc.used || !equal(tx.oidc.browserHash,digest(browser))) reject('PROOF_INVALID',401,'Retorno de login inválido.');
            tx.oidc.used = true;
            return { id:tx.id,verifierCipher:tx.oidc.verifierCipher,nonceHash:tx.oidc.nonceHash };
        });
        let subject: string;
        try { subject = await this.oidc.exchangeSubject(code,this.decipher(saved.verifierCipher),saved.nonceHash,'/api/control/auth/native/callback'); }
        catch { return reject('PROOF_INVALID',401,'O provedor não confirmou a identidade. Inicie outro login.'); }
        const grant = randomToken(), csrf = randomToken();
        await this.state(async store => {
            const tx = this.transaction(store,saved.id);
            await this.actor(store,subject);
            tx.subject = subject; tx.browser = { hash:digest(grant),csrfHash:digest(csrf),subject };
            // Remove encrypted OIDC secret once exchange is complete; retain replay marker only.
            if (tx.oidc) tx.oidc.verifierCipher = '';
        });
        return { transactionId:saved.id, browser:grant, csrf };
    }
    async confirmation(id: string, browser: string) {
        return this.state(async store => {
            const tx = this.transaction(store,id);
            if (!tx.browser || !equal(tx.browser.hash,digest(browser))) return reject('IDENTITY_MISMATCH',403,'Identidade da confirmação não corresponde ao login.');
            const actor = await this.actor(store,tx.browser.subject);
            const csrf = randomToken(); tx.browser.csrfHash = digest(csrf);
            return { transactionId:tx.id,userCode:tx.code,name:actor.name,subject:actor.id,approved:tx.approved,csrf };
        });
    }
    async confirm(input: unknown, browser: string) {
        const request = this.parse(nativeConfirmSchema,input);
        return this.state(async store => {
            const tx = this.transaction(store,request.transactionId);
            if (!tx.browser || !equal(tx.browser.hash,digest(browser)) || tx.browser.subject !== tx.subject) reject('IDENTITY_MISMATCH',403,'Identidade da confirmação não corresponde ao login.');
            if (!equal(tx.browser.csrfHash,digest(request.csrfToken))) reject('CSRF_REJECTED',403,'Confirmação inválida.');
            if (tx.approved || request.userCode !== tx.code) reject('CONFIRMATION_REQUIRED',409,'Confira o código e inicie outro login se necessário.');
            const actor = await this.actor(store,tx.subject!);
            tx.approved = true;
            store.state.audit.push({timestamp:this.now(),subject:actor.id,event:'confirmed',outcome:'APPROVED'});
            return { approved:true };
        });
    }
    async status(input: unknown): Promise<NativeAuthorizationStatus> {
        const request = this.parse(nativePollSchema,input);
        return this.state(async store => {
            const tx = this.transaction(store,request.transactionId);
            this.proof(tx,request.deviceCode,request.codeVerifier);
            if (tx.lastPoll && this.now()-tx.lastPoll < INTERVAL*1000 || ++tx.polls > 65) reject('RATE_LIMITED',429,'Aguarde cinco segundos antes de consultar novamente.');
            tx.lastPoll = this.now();
            if (!tx.approved) return {state:'pending',intervalSeconds:INTERVAL};
            const actor = await this.actor(store,tx.subject!);
            return {state:'approved',operator:{subject:actor.id,name:actor.name},intervalSeconds:INTERVAL};
        });
    }
    async complete(input: unknown): Promise<NativeSessionCredential> {
        const request = this.parse(nativeCompleteSchema,input), accessToken = 'sos_operator_'+randomToken();
        return this.state(async store => {
            const tx = this.transaction(store,request.transactionId);
            this.proof(tx,request.deviceCode,request.codeVerifier);
            if (!tx.approved) reject('CONFIRMATION_REQUIRED',409,'Confirmação explícita no navegador obrigatória.');
            if (request.expectedSubject !== tx.subject) reject('IDENTITY_MISMATCH',403,'Identidade inesperada. Inicie outro login.');
            const actor = await this.actor(store,tx.subject!);
            // A database lookup must not permit issuance after the transaction expires.
            this.transaction(store,request.transactionId);
            if (store.state.sessions.length>=5000) reject('RATE_LIMITED',429,'Sessões temporariamente indisponíveis.');
            const active = store.state.sessions.filter(s => s.subject === actor.id && !s.revoked && s.expires>this.now()).sort((a,b)=>a.created-b.created);
            while (active.length>=5) { active.shift()!.revoked = true; store.state.audit.push({timestamp:this.now(),subject:actor.id,event:'session_limit',outcome:'REVOKED_OLDEST'}); }
            const expires = this.now()+SESSION_TTL;
            tx.consumed = true;
            store.state.sessions.push({hash:digest(accessToken),subject:actor.id,expires,created:this.now(),revoked:false});
            store.state.audit.push({timestamp:this.now(),subject:actor.id,event:'session_created',outcome:'CREATED'});
            return {accessToken,tokenType:'Bearer',scope:'control',expiresAt:new Date(expires).toISOString()};
        });
    }
    async authenticate(token: string): Promise<{ actor: Actor; session: NativeSession }> {
        if (!/^sos_operator_[A-Za-z0-9_-]{43}$/.test(token)) reject('SESSION_INVALID',401,'Credencial de operador inválida.');
        return this.state(async store => {
            const session = store.state.sessions.find(s=>equal(s.hash,digest(token)));
            if (!session) reject('SESSION_INVALID',401,'Sessão nativa inválida.');
            if (session.revoked) reject('SESSION_REVOKED',401,'Sessão nativa revogada.');
            if (session.expires<=this.now()) reject('SESSION_EXPIRED',401,'Sessão nativa expirada. Entre novamente.');
            const actor = await this.actor(store,session.subject);
            return {actor,session:{subject:actor.id,name:actor.name,memberships:actor.memberships,expiresAt:new Date(session.expires).toISOString(),scope:'control'}};
        });
    }
    async logout(token: string) {
        // Revocation stays available even after disabling the user or removing membership.
        if (!/^sos_operator_[A-Za-z0-9_-]{43}$/.test(token)) reject('SESSION_INVALID',401,'Credencial de operador inválida.');
        return this.state(async store => {
            const session = store.state.sessions.find(s=>equal(s.hash,digest(token)));
            if (!session) reject('SESSION_INVALID',401,'Sessão nativa inválida.');
            session.revoked = true;
            store.state.audit.push({timestamp:this.now(),subject:session.subject,event:'logout',outcome:'REVOKED'});
            return {revoked:true};
        });
    }
}
