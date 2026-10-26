import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Search, MapPin, Plus, Bookmark, X, ArrowRight, LoaderCircle, RefreshCw} from 'lucide-react';
import {CATEGORIES, type Place} from '../model';
import {searchPlaces} from '../googleMaps';

type Props = {
  destination: string;
  onPreview: (place: Place) => void;
  onSave: (place: Place) => void;
  onAdd: (place: Place) => void;
  statusOf: (id: string) => string;
  selected?: string | null;
  onClose?: () => void;
  onCustom?: () => void;
  onChoose?: (place: Place) => void;
  initialQuery?: string;
  purpose?: 'discover' | 'hotel' | 'locate';
};

export function PlaceAttribution({place}: {place: Place}) {
  return <>{place.attributions?.map((a,i)=><span key={i}>{a.providerURI?<a href={a.providerURI} target="_blank" rel="noreferrer">{a.provider}</a>:a.provider}</span>)}</>;
}

export default function DiscoveryPanel({destination,onPreview,onSave,onAdd,statusOf,selected,onClose,onCustom,onChoose,initialQuery='',purpose='discover'}:Props) {
  const [query,setQuery]=useState(initialQuery),[category,setCategory]=useState('all');
  const [results,setResults]=useState<Place[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[searched,setSearched]=useState(false);
  const requestId=useRef(0);
  useEffect(()=>()=>{requestId.current+=1;},[]);
  useEffect(()=>{setQuery(initialQuery);setResults([]);setSearched(false);setError('');requestId.current+=1;setLoading(false);},[destination,initialQuery]);
  async function search(text=query,filter=category) {
    const trimmed=text.trim(); if(!trimmed)return;
    const id=++requestId.current;
    setQuery(text);setCategory(filter);setLoading(true);setError('');setSearched(true);
    try {const found=await searchPlaces(trimmed,destination,filter);if(requestId.current===id)setResults(found);}
    catch {if(requestId.current===id){setResults([]);setError('Places could not load. Check your connection or Google Maps access, then try again.');}}
    finally {if(requestId.current===id)setLoading(false);}
  }
  function submit(e:FormEvent){e.preventDefault();void search();}
  const title=purpose==='hotel'?'Choose your hotel or base':purpose==='locate'?'Find the exact location':`Discover in ${destination.split(',')[0]}`;
  return <>
    <div className="discovery-top">
      <div className="section-heading"><h2>{title}</h2>{onClose&&<button className="icon-button tiny" onClick={onClose} aria-label="Close discovery"><X size={16}/></button>}</div>
      <form onSubmit={submit} className="live-search-form">
        <label className="search-label" htmlFor={`search-${purpose}`}>{purpose==='hotel'?'Hotel name, station, or address':'Search places near this trip'}</label>
        <div className="search-input"><Search size={17}/><input id={`search-${purpose}`} type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={purpose==='hotel'?'e.g. Hotel Granvia Kyoto':'Temples, markets, food…'} maxLength={240}/><button type="submit" aria-label="Search Google Maps" disabled={loading||!query.trim()}>{loading?<LoaderCircle size={16} className="spin"/>:<ArrowRight size={17}/>}</button></div>
      </form>
      {purpose==='discover'&&<div className="filter-chips" role="group" aria-label="Filter by category">{[['all','All'],['attr','Sights'],['food','Food & drink']].map(([value,label])=><button key={value} aria-pressed={category===value} onClick={()=>{setCategory(value);if(query.trim())void search(query,value);}}>{label}</button>)}</div>}
      {purpose!=='discover'&&<p className="subtle-note">{purpose==='hotel'?'Your stay is the default start and the return point. Set a different departure in Day plan.':'Choose a result to pin this stop and calculate its journeys.'}</p>}
    </div>
    <div className="discovery-results live-results" aria-busy={loading}>
      {loading&&<div className="search-progress" role="status"><LoaderCircle size={18} className="spin"/>Finding places on Google Maps…</div>}
      {error&&<div className="empty-state" role="alert"><MapPin size={28}/><h3>Search unavailable</h3><p>{error}</p><button className="button small" onClick={()=>void search()}><RefreshCw size={14}/>Try again</button></div>}
      {!loading&&!error&&results.map(p=><article key={p.id} className={`place-card live-place-card ${selected===p.id?'active':''}`}>
        <button className="place-card-main" onClick={()=>onChoose?onChoose(p):onPreview(p)} aria-label={onChoose?`Choose ${p.name}`:`Preview ${p.name}`} aria-pressed={!onChoose&&selected===p.id}>
          <span className="place-type-icon" style={{color:CATEGORIES[p.cat].ink,background:CATEGORIES[p.cat].tint}}><MapPin size={17}/></span>
          <strong>{p.name}</strong><small>{p.area}</small>
        </button>
        {onChoose?<button className="button small live-choose" onClick={()=>onChoose(p)}>Use this place<ArrowRight size={13}/></button>:<div className="live-place-actions">{statusOf(p.id)?<span className="place-status">{statusOf(p.id)}</span>:<><button className="text-button" onClick={()=>onSave(p)} aria-label={`Save ${p.name} to Ideas`}><Bookmark size={13}/>Save</button><button className="button small" onClick={()=>onAdd(p)} aria-label={`Add ${p.name} to itinerary`}><Plus size={13}/>Add</button></>}</div>}
        {!!p.attributions?.length&&<div className="provider-attributions"><PlaceAttribution place={p}/></div>}
      </article>)}
      {!loading&&!error&&searched&&!results.length&&<div className="empty-state"><Search size={28}/><h3>No places found</h3><p>Try a more specific name, neighbourhood, or address.</p></div>}
      {!searched&&<div className="discovery-welcome"><span className="discovery-welcome-icon"><CompassMark/></span><h3>{purpose==='hotel'?'Start somewhere lovely.':'Find your next favourite.'}</h3><p>{purpose==='hotel'?'Search for your stay or another base to complete each day’s return journey.':`Search for a place in ${destination}, or start with a little inspiration.`}</p>{purpose==='discover'&&<div className="discovery-suggestions">{[['Temples and gardens','attr'],['Coffee shops','all'],['Local restaurants','food'],['Museums','attr']].map(([text,filter])=><button className="button small" key={text} onClick={()=>void search(text,filter)}>{text}<ArrowRight size={13}/></button>)}</div>}{initialQuery&&<button className="button primary full" onClick={()=>void search()}>Search for {initialQuery}<Search size={15}/></button>}</div>}
    </div>
    <div className="discovery-footer">{onCustom&&<button className="button dashed full" onClick={onCustom}><MapPin size={16}/>Add a custom location</button>}<span className="google-attribution">Google Maps</span><small className="discovery-legal"><a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a><span>·</span><a href="/terms.html" target="_blank" rel="noreferrer">Terms</a></small></div>
  </>;
}
function CompassMark(){return <MapPin size={27}/>;}
