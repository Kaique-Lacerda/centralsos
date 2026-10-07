import { useRef, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { PrinterService } from '../services/printers/PrinterService';
import { validatePrinterUnc, type DiscoveredPrinter } from '../services/printers/PrinterConnections';
import type { SnapshotCollection } from '../../packages/contracts/machine';

export function PrinterAddPanel({close,refresh,notify}:{close:()=>void;refresh:()=>Promise<void>;notify:(message:string)=>void}) {
  const [path,setPath]=useState('');const [searching,setSearching]=useState(false);const [adding,setAdding]=useState('');
  const [results,setResults]=useState<SnapshotCollection<DiscoveredPrinter>|null>(null);const [error,setError]=useState('');
  const searchInFlight=useRef(false);const addInFlight=useRef(false);
  const search=async()=>{
    if(searchInFlight.current)return;searchInFlight.current=true;setSearching(true);setError('');setResults(null);
    try{setResults(await PrinterService.discoverNetworkPrinters());}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{searchInFlight.current=false;setSearching(false);}
  };
  const add=async(unc:string)=>{
    if(addInFlight.current)return;const validation=validatePrinterUnc(unc);if(validation){setError(validation);return;}
    addInFlight.current=true;setAdding(unc);setError('');
    try{await PrinterService.addConnection(unc);await refresh();notify(`Impressora adicionada: ${unc}.`);close();}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{addInFlight.current=false;setAdding('');}
  };
  return <div className="printer-settings-backdrop"><section className="printer-panel printer-add-panel" role="dialog" aria-modal="true" aria-label="Adicionar impressora">
    <header className="printer-panel-heading"><h3>Adicionar impressora</h3><button className="printer-icon-button" aria-label="Fechar" disabled={!!adding} onClick={close}><X size={17}/></button></header>
    <div className="printer-panel-content">
      <section className="printer-settings-section"><h4>Buscar na rede</h4>
        <p>A busca depende do provider e da rede do Windows. Impressoras não encontradas podem ser adicionadas por caminho.</p>
        <button className="printer-secondary-action" disabled={searching||!!adding} onClick={()=>void search()}><Search size={14}/>Buscar impressoras</button>
        {searching&&<p role="status">Buscando impressoras na rede...</p>}
        {results?.error&&<p className="printer-action-message error" role="status">{results.error}</p>}
        {results&&!results.items.length&&<p>Nenhuma impressora compartilhada foi encontrada nesta busca.</p>}
        {results?.items.map(printer=><article className="printer-discovery-item" key={printer.path}><b>{printer.name}</b><small>Servidor: {printer.server}</small><code>{printer.path}</code>{printer.description&&<small>{printer.description}</small>}<button className="printer-secondary-action" disabled={!!adding} onClick={()=>void add(printer.path)}><Plus size={14}/>{adding===printer.path?'Adicionando…':'Adicionar'}</button></article>)}
      </section>
      <section className="printer-settings-section"><h4>Adicionar por caminho</h4>
        <label>Caminho compartilhado<input placeholder={'\\\\servidor\\impressora'} value={path} onChange={event=>setPath(event.target.value)} maxLength={512} disabled={!!adding}/></label>
        <button className="primary" disabled={!!adding||!path} onClick={()=>void add(path)}>{adding===path?'Adicionando…':'Adicionar'}</button>
      </section>
      {error&&<p className="printer-action-message error" role="alert">{error}</p>}
    </div>
  </section></div>;
}
