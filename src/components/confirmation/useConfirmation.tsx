import { useEffect, useRef, useState } from 'react';
export function useConfirmation() {
  const [request, setRequest] = useState<{ text: string; finish: (confirmed: boolean) => void } | null>(null);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);
  useEffect(() => () => { pending.current?.(false); }, []);
  const confirm = (text: string) => new Promise<boolean>(resolve => {
    pending.current?.(false); pending.current = resolve;
    setRequest({ text, finish: value => { pending.current = null; setRequest(null); resolve(value); } });
  });
  const dialog = request && <div className="support-modal-backdrop"><section className="support-modal" role="dialog" aria-modal="true" aria-labelledby="support-confirm-title"><h2 id="support-confirm-title">Confirmar alteração</h2><p>{request.text}</p><div className="support-actions"><button className="linkbtn" onClick={() => request.finish(false)} autoFocus>Cancelar</button><button className="primary" onClick={() => request.finish(true)}>Confirmar</button></div></section></div>;
  return { confirm, dialog };
}
