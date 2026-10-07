import { useEffect, useState } from 'react';
import { CircleAlert, Download } from 'lucide-react';
import { getLatestWindowsRelease, type WindowsReleaseLookup } from '../../services/releases/GitHubReleaseService';
import '../../release-download.css';
function Heading({tag,title,description}:{tag:string;title:string;description:string}){return <div className="heading"><small>{tag}</small><h1>{title}</h1><p>{description}</p></div>}
export function ClientDownloadPage(){
  const [release,setRelease]=useState<WindowsReleaseLookup|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(false);
  const load=async(refresh=false)=>{
    setLoading(true);setError(false);
    try{setRelease(await getLatestWindowsRelease({refresh}))}catch{setRelease(null);setError(true)}finally{setLoading(false)}
  };
  useEffect(()=>{void load()},[]);
  const availableRelease=release?.status==='available'?release:null;
  const asset=availableRelease?.asset??null;
  const formatSize=(bytes:number|null)=>bytes===null?'':bytes<1024*1024?`${(bytes/1024).toLocaleString('pt-BR',{maximumFractionDigits:0})} KB`:`${(bytes/1024/1024).toLocaleString('pt-BR',{maximumFractionDigits:1})} MB`;
  const publishedAt=release?.status==='available'&&release.publishedAt?new Date(release.publishedAt).toLocaleDateString('pt-BR'):null;
  return <><Heading tag="APLICATIVO WINDOWS" title="Download" description="Versão Desktop da CENTRAL SOS."/><section className="panel release-card"><div className="release-icon"><Download/></div><div className="release-content"><b>CENTRAL SOS para Windows</b>{loading?<p>Consultando última versão…</p>:error?<><p>Não foi possível consultar a versão disponível.</p><button className="linkbtn" onClick={()=>void load(true)}>Tentar novamente</button></>:availableRelease?<><p>{availableRelease.version?`Versão ${availableRelease.version}`:'Versão não informada'}{publishedAt?` · Publicado em ${publishedAt}`:''}</p><small>{availableRelease.asset.name}{availableRelease.asset.sizeBytes!==null?` · ${formatSize(availableRelease.asset.sizeBytes)}`:''}</small></>:release?.status==='ambiguous-release'?<p>Há Releases do aplicativo com a mesma maior versão. Não foi possível determinar qual instalador usar.</p>:release?.status==='ambiguous'?<p>Há mais de um instalador possível nesta release. Não foi possível determinar o arquivo correto.</p>:release?.status==='no-installer'?<p>Instalador ainda não publicado.</p>:<><p>Nenhuma versão publicada</p><p>O instalador do CENTRAL SOS estará disponível aqui quando uma Release for publicada.</p></>}</div><div className="release-actions">{asset?<a className="primary" href={asset.downloadUrl} target="_blank" rel="noopener noreferrer" download>Baixar para Windows</a>:<button className="primary" disabled>Indisponível</button>}{!loading&&!error&&<button className="linkbtn" onClick={()=>void load(true)}>Atualizar</button>}</div></section>{error&&<p className="error"><CircleAlert/> A consulta ao GitHub falhou. Verifique a conexão e tente novamente.</p>}</>;
}
