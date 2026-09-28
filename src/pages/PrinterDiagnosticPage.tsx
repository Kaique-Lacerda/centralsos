import { useState } from 'react';
import { AlertTriangle, CircleAlert, Monitor, Printer, RefreshCw } from 'lucide-react';
import { runtimeEnvironment } from '../services/runtime/environment';
import { PrinterService } from '../services/printers/PrinterService';
import { classifyPrinter, getPrinterSignals, partialCollectionNotice, printerAvailability, summarizePrinters } from '../services/printers/PrinterDiagnostic';
import type { SnapshotCollection, PrinterSnapshot } from '../types/machine';
import '../printer-diagnostic.css';

function PrinterCard({ printer }: { printer: PrinterSnapshot }) {
  const kind = classifyPrinter(printer);
  const availability = printerAvailability(printer.status);
  const signals = getPrinterSignals(printer);
  return <article className="printer-card">
    <div className="printer-card-heading"><div className="printer-card-icon"><Printer size={18}/></div><div className="printer-card-title"><h2>{printer.name}</h2><div className="printer-badges">{printer.isDefault&&<span className="printer-badge default">Padrão</span>}<span className={`printer-badge ${availability===true?'connected':availability===false?'offline':'unknown'}`}>{availability===true?'Disponível':availability===false?'Indisponível':'Estado não conclusivo'}</span><span className="printer-badge type">{kind}</span></div></div></div>
    <dl className="printer-details">{signals.map(signal=><div className={`printer-detail ${signal.state}`} key={signal.id}><dt>{signal.label}</dt><dd>{signal.detail}</dd></div>)}</dl>
    <div className="printer-diagnostics">{signals.map(signal=><p key={signal.id} className={signal.state}>{signal.state==='available'?'✓':signal.state==='problem'?'✗':'⚠'} {signal.label}: {signal.state==='available'?'identificado':signal.state==='problem'?'requer atenção':'informação não disponível'}</p>)}</div>
  </article>;
}

export function PrinterDiagnosticPage() {
  const [collection, setCollection] = useState<SnapshotCollection<PrinterSnapshot> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const update = async () => {
    if (runtimeEnvironment !== 'desktop') return;
    setBusy(true); setError('');
    try {
      const snapshot = await PrinterService.getPrinters();
      setCollection(snapshot);
      setCapturedAt(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao coletar impressoras.');
    } finally { setBusy(false); }
  };
  const summary = collection ? summarizePrinters(collection) : null;
  const collectionNotice = collection ? partialCollectionNotice(collection) : null;
  return <>
    <header className="printer-page-heading"><div><small>FERRAMENTA · IMPRESSÃO</small><h1>Diagnóstico de Impressoras</h1><p>Informações locais para iniciar o diagnóstico de impressão. Coleta somente leitura.</p></div><button className="primary printer-refresh" disabled={busy||runtimeEnvironment!=='desktop'} onClick={update}><RefreshCw size={14}/>{busy?'Atualizando…':'Atualizar diagnóstico'}</button></header>
    {runtimeEnvironment==='web'&&<p className="notice"><Monitor/> Esta ferramenta depende do Desktop Windows. Abra a CENTRAL SOS no aplicativo Desktop para consultar as impressoras; nenhuma coleta local foi executada.</p>}
    {error&&<p className="error"><CircleAlert/>{error}</p>}
    {collection&&summary&&<>
      {capturedAt&&<p className="printer-captured">Atualizado em {new Date(capturedAt).toLocaleString()}</p>}
      {collectionNotice&&<p className="notice"><AlertTriangle/> {collectionNotice}</p>}
      <section className="printer-summary" aria-label="Resumo das impressoras">
        <div><small>Total</small><b>{summary.total}</b><span>impressoras</span></div>
        <div><small>Disponíveis</small><b>{summary.available}{summary.determinedStatusCount<summary.total?'*':''}</b><span>{summary.determinedStatusCount} com estado determinável</span></div>
        <div><small>Compartilhadas / remotas</small><b>{summary.sharedOrRemote}</b><span>classificação identificada</span></div>
        <div><small>Impressora padrão</small><b>{summary.defaultPrinters.length===1?summary.defaultPrinters[0]:summary.defaultPrinters.length>1?'Mais de uma identificada':'Não identificada'}</b><span>{summary.defaultPrinters.length===1?'identificada pelo Windows':'Não disponível/conclusivo'}</span></div>
      </section>
      {summary.total>0&&summary.determinedStatusCount<summary.total&&<p className="printer-footnote">* A contagem considera apenas estados que o Windows forneceu e que permitem determinar disponibilidade.</p>}
      {summary.total===0?<div className="empty printer-empty"><Printer/><b>Nenhuma impressora retornada</b><p>{collection.error?'A consulta não retornou dados. Verifique o aviso de coleta parcial acima.':'O Windows não retornou impressoras instaladas.'}</p></div>:<section className="printer-list" aria-label="Impressoras encontradas">{collection.items.map((printer,index)=><PrinterCard key={`${printer.name}-${index}`} printer={printer}/>)}</section>}
    </>}
  </>;
}
