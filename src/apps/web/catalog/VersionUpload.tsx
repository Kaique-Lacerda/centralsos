import { useRef, useState, type FormEvent } from 'react';
import type { CatalogSession } from '../../../../packages/contracts/catalog';
import { catalogRequest } from './CatalogApi';
export function VersionUpload({ toolId, session, onDone }: { toolId: string; session: CatalogSession; onDone: () => Promise<void> }) {
    const [version, setVersion] = useState(''), [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const fileInput = useRef<HTMLInputElement>(null);
    async function submit(event: FormEvent) {
        event.preventDefault(); if (!file) return;
        if (file.size > 100 * 1024 * 1024) { setMessage('O limite por arquivo é 100 MiB.'); return; }
        setBusy(true); setMessage('Preparando envio privado…');
        try {
            const intent = await catalogRequest<{ versionId: string; uploadUrl: string; contentType: string }>(`tools/${toolId}/upload`, session, 'POST', { version, fileName: file.name, size: file.size });
            setMessage('Enviando arquivo…');
            const response = await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': intent.contentType, 'X-Content-Type': intent.contentType }, body: file })
                .catch(() => { throw new Error('Não foi possível enviar o arquivo ao armazenamento. Verifique sua conexão e tente novamente.'); });
            if (!response.ok) throw new Error('O envio falhou. O arquivo permanece indisponível.');
            setMessage('Verificando arquivo e SHA-256…');
            await catalogRequest(`versions/${intent.versionId}/finalize`, session, 'POST');
            setMessage('Arquivo verificado. Aprove a publicação para disponibilizá-lo.'); setVersion(''); setFile(null);
            if (fileInput.current) fileInput.current.value = '';
            await onDone();
        } catch (failure) { setMessage(failure instanceof Error ? failure.message : 'Não foi possível enviar.'); await onDone().catch(() => undefined); }
        finally { setBusy(false); }
    }
    return <details className="catalog-version-upload"><summary>Enviar nova versão</summary><form onSubmit={submit}>
        <label>Versão<input value={version} onChange={e => setVersion(e.target.value)} required maxLength={60} disabled={busy} placeholder="Versão do arquivo" /></label>
        <label>Instalador<input ref={fileInput} type="file" accept=".exe,.msi,.zip" required disabled={busy} onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
        <small>EXE, MSI ou ZIP · até 100 MiB · armazenamento privado</small><button className="portal-tool-download" disabled={busy}>Enviar e verificar</button>
        {message && <p role="status">{message}</p>}
    </form></details>;
}
