import {useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent} from 'react';
import {ArrowDown, ArrowLeft, ArrowRight, Beer, Bookmark, Camera, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Coffee, Compass, ExternalLink, Landmark, LoaderCircle, MapPin, Plus, Search, ShoppingBag, Star, TreePine, Umbrella, Utensils, X} from 'lucide-react';
import type {Place} from '../model';
import {getWeekdayHoursLabel} from '../openingHours';
import {withPlaceAdmission} from '../placeHours';
import {getDiscoveryPhotoURL, getOpeningSummary, type DiscoveryCategory, type DiscoveryPhoto, type DiscoveryResult} from '../discoveryData';
import './discovery.css';

export type DiscoveryExplorerProps = {
  destination: string;
  dayLabel: string;
  addHere?: boolean;
  tripDate: string;
  query: string;
  setQuery: (query: string) => void;
  category: DiscoveryCategory;
  onCategory: (category: DiscoveryCategory) => void;
  results: DiscoveryResult[];
  loading: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  moreError?: string;
  onLoadMore?: () => void;
  error: string;
  searched: boolean;
  scope: 'destination' | 'area';
  selectedResult: DiscoveryResult | null;
  detailsLoading?: boolean;
  detailsError?: string;
  onSearch: () => void;
  onSelect: (result: DiscoveryResult) => void;
  onBack: () => void;
  onBackToDestination: () => void;
  onPreviewMap?: (result: DiscoveryResult) => void;
  onRetryDetails?: () => void;
  onSave: (place: Place) => void;
  onAdd: (place: Place) => void;
  onChooseAdd?: (place: Place) => void;
  statusOf: (id: string) => string;
  onClose?: () => void;
  onCustom?: () => void;
  scrollTop: number;
  onScrollTop: (top: number) => void;
};

const filters: {value: DiscoveryCategory; label: string; icon: typeof Compass}[] = [
  {value:'all',label:'All',icon:Compass},
  {value:'attractions',label:'Attractions',icon:MapPin},
  {value:'museums',label:'Museums',icon:Landmark},
  {value:'parks',label:'Parks',icon:TreePine},
  {value:'restaurants',label:'Restaurants',icon:Utensils},
  {value:'cafes',label:'Cafés',icon:Coffee},
  {value:'shopping',label:'Shopping',icon:ShoppingBag},
  {value:'nightlife',label:'Bars & pubs',icon:Beer},
  {value:'indoor',label:'Indoor ideas',icon:Umbrella},
];

function readableType(value: string | undefined, place: Place) {
  if (!value) return place.cat === 'food' ? 'Food & drink' : place.cat === 'attr' ? 'Place to explore' : 'Place';
  return value.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase());
}

/** SDK photo URLs are resolved only when this image enters its scroll viewport. */
function LazyPhoto({photo, name, hero=false}: {photo?: DiscoveryPhoto; name:string; hero?:boolean}) {
  const host = useRef<HTMLSpanElement>(null);
  const [url,setURL] = useState<string>();
  const [failed,setFailed] = useState(false);
  const [loaded,setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    setURL(undefined); setFailed(false); setLoaded(false);
    if (!photo) return;
    const reveal = () => {
      if (!active) return;
      try {
        const next = getDiscoveryPhotoURL(photo, hero ? 800 : 240);
        if (next) setURL(next); else setFailed(true);
      } catch {setFailed(true);}
    };
    if (!host.current || typeof IntersectionObserver === 'undefined') {reveal(); return () => {active=false;};}
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {reveal();observer.disconnect();}
    }, {rootMargin:'0px',threshold:0.01});
    observer.observe(host.current);
    return () => {active=false;observer.disconnect();};
  }, [photo?.key,hero]);
  return <span ref={host} className={`dx-photo ${hero?'dx-photo-hero':''} ${loaded&&!failed?'dx-photo-loaded':''}`}>
    <span className="dx-photo-placeholder" aria-hidden="true"><span/><Landmark size={hero?38:26}/><i/></span>
    {url&&!failed&&<img src={url} alt={name} loading="lazy" decoding="async" onLoad={()=>setLoaded(true)} onError={()=>setFailed(true)}/>}
    {hero&&(!photo||failed)&&<span className="dx-no-photo"><Camera size={14}/>{failed?'Photo unavailable':'No photo available'}</span>}
  </span>;
}

function PhotoCredit({photo}: {photo?:DiscoveryPhoto}) {
  if (!photo?.authors.length) return null;
  return <div className="dx-photo-credit"><Camera size={10} aria-hidden="true"/><span>{photo.authors.map((author,index)=><span key={`${author.name}-${index}`}>{index>0?', ':''}{author.uri?<a href={author.uri} target="_blank" rel="noreferrer">{author.name}</a>:author.name}</span>)}</span></div>;
}

function Rating({result}: {result:DiscoveryResult}) {
  const {rating,ratingCount}=result.info;
  if (rating===undefined) return <span className="dx-rating dx-rating-unavailable">{ratingCount===0?'No ratings yet':'Rating unavailable'}</span>;
  return <span className="dx-rating"><Star size={12} fill="currentColor" aria-hidden="true"/><strong>{rating.toFixed(1)}</strong>{ratingCount!==undefined&&<span>· {ratingCount.toLocaleString('en')} {ratingCount===1?'rating':'ratings'}</span>}</span>;
}

function ProviderCredit({place}: {place:Place}) {
  if (!place.attributions?.length) return null;
  return <div className="dx-provider-credit">{place.attributions.map((entry,index)=><span key={index}>{entry.providerURI?<a href={entry.providerURI} target="_blank" rel="noreferrer">{entry.provider}</a>:entry.provider}</span>)}</div>;
}

function PlaceActions({result,props}: {result:DiscoveryResult;props:DiscoveryExplorerProps}) {
  const status=props.statusOf(result.place.id),saved=status==='In Ideas';
  return <div className="dx-place-actions">
    {status?<span className="dx-saved"><Check size={13}/>{status}</span>:<button type="button" className="dx-save" onClick={()=>props.onSave(result.place)} aria-label={`Save ${result.place.name} to Ideas`}><Bookmark size={14}/>Save</button>}
    {(!status||saved)&&<div className={`dx-add-group ${props.onChooseAdd?'dx-add-group-split':''}`}>
      <button type="button" className="button primary small" onClick={()=>props.onAdd(result.place)} aria-label={`Add ${result.place.name} ${props.addHere?'here':'to '+props.dayLabel}`}><Plus size={13}/>{props.addHere?'Add here':'Add to '+props.dayLabel}</button>
      {props.onChooseAdd&&<button type="button" className="dx-choose-add" onClick={()=>props.onChooseAdd?.(result.place)} aria-label={`Choose day and position for ${result.place.name}`} title="Choose a day and position"><ChevronDown size={15}/></button>}
    </div>}
  </div>;
}

function ResultCard({result,props,onSelect,now}: {result:DiscoveryResult;props:DiscoveryExplorerProps;onSelect:()=>void;now:Date}) {
  const today=getOpeningSummary(result.info,{date:props.tripDate,now}),photo=result.info.photos[0];
  return <article className="dx-card">
    <div className="dx-card-main">
      <button type="button" className="dx-photo-button" onClick={onSelect} aria-label={`View ${result.place.name}`}><LazyPhoto photo={photo} name={result.place.name}/></button>
      <button type="button" className="dx-card-title" onClick={onSelect}>
        <span className="dx-place-kind">{readableType(result.info.primaryType,result.place)}</span>
        <strong>{result.place.name}</strong>
        <Rating result={result}/>
      </button>
    </div>
    <PhotoCredit photo={photo}/>
    <p className={`dx-card-hours dx-hours-${today.status}`}><Clock3 size={12} aria-hidden="true"/><span><b>{getWeekdayHoursLabel(withPlaceAdmission(result.info,result.place),props.tripDate)}</b><small>{today.dayLabel} · {props.dayLabel}</small></span></p>
    <PlaceActions result={result} props={props}/>
    <ProviderCredit place={result.place}/>
  </article>;
}

function DetailView({result,props,now}: {result:DiscoveryResult;props:DiscoveryExplorerProps;now:Date}) {
  const [photoIndex,setPhotoIndex]=useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(()=>{setPhotoIndex(0);scroll.current?.scrollTo({top:0});title.current?.focus({preventScroll:true});},[result.place.id]);
  const activeIndex=Math.min(photoIndex,Math.max(0,result.info.photos.length-1));
  const photo=result.info.photos[activeIndex];
  const hours=getOpeningSummary(result.info,{date:props.tripDate,now});
  const today=getOpeningSummary(result.info,{now});
  const weekly=result.info.regularHours?.weekdayDescriptions??[];
  return <>
    <div className="dx-detail-toolbar"><button type="button" className="dx-back" onClick={props.onBack}><ArrowLeft size={16}/>All results</button>{props.onClose&&<button type="button" className="icon-button" onClick={props.onClose} aria-label="Close discovery"><X size={17}/></button>}</div>
    <div ref={scroll} className="dx-detail-scroll">
      <div className="dx-detail-photo"><LazyPhoto key={`${result.place.id}-${photo?.key}`} photo={photo} name={result.place.name} hero/>
        {result.info.photos.length>1&&<div className="dx-photo-controls"><button type="button" aria-label="Previous photo" disabled={activeIndex===0} onClick={()=>setPhotoIndex(index=>Math.max(0,index-1))}><ChevronLeft size={16}/></button><span>{activeIndex+1} / {result.info.photos.length}</span><button type="button" aria-label="Next photo" disabled={activeIndex>=result.info.photos.length-1} onClick={()=>setPhotoIndex(index=>index+1)}><ChevronRight size={16}/></button></div>}
      </div>
      <PhotoCredit photo={photo}/>
      <div className="dx-detail-copy">
        <span className="dx-place-kind">{readableType(result.info.primaryType,result.place)}</span>
        <h2 ref={title} tabIndex={-1}>{result.place.name}</h2>
        <Rating result={result}/>
        <p className="dx-address"><MapPin size={14} aria-hidden="true"/><span>{result.place.area||'Address unavailable'}</span></p>
        {props.onPreviewMap&&<button type="button" className="dx-map-preview" onClick={()=>props.onPreviewMap?.(result)}><MapPin size={14}/>Explore on the map<ArrowRight size={14}/></button>}
        <section className="dx-hours-section" aria-label="Opening hours">
          <div className="dx-hours-heading"><Clock3 size={15}/><h3>Opening hours</h3>{props.detailsLoading&&<LoaderCircle size={14} className="spin" aria-label="Loading opening hours"/>}</div>
          {props.detailsError&&<p className="dx-details-error" role="alert">{props.detailsError}{props.onRetryDetails&&<button type="button" onClick={props.onRetryDetails}>Try again</button>}</p>}
          <div className={`dx-today dx-hours-${today.status}`}><span className="dx-status-dot"/><span><strong>{today.label}</strong>{today.hours.length>0&&<small>Today · {today.hours.join(' · ')}</small>}</span></div>
          <div className="dx-planned-hours"><span>For {props.dayLabel} · {formatDate(props.tripDate)}</span><strong>{getWeekdayHoursLabel(withPlaceAdmission(result.info,result.place),props.tripDate)}</strong>{hours.detail&&<small>{hours.detail}</small>}</div>
          {weekly.length>0&&<details className="dx-weekly-hours"><summary>Regular weekly hours</summary><ul>{weekly.map((line,index)=><li key={index}>{line}</li>)}</ul><p>Check with the place for holiday hours or special closures.</p></details>}
        </section>
        {result.place.googleMapsURI&&<a className="dx-google-link" href={result.place.googleMapsURI} target="_blank" rel="noreferrer">View on Google Maps<ExternalLink size={13}/></a>}
        <ProviderCredit place={result.place}/>
      </div>
    </div>
    <div className="dx-detail-actions"><PlaceActions result={result} props={props}/></div>
  </>;
}

function formatDate(date:string) {
  const value=new Date(`${date}T12:00:00Z`);
  return Number.isFinite(value.getTime())?new Intl.DateTimeFormat('en',{day:'numeric',month:'short',timeZone:'UTC'}).format(value):date;
}

function LoadingCards() {
  return <><p className="dx-loading-label" role="status"><LoaderCircle size={15} className="spin"/>Finding your next favourite…</p>{[0,1,2].map(index=><div className="dx-card dx-skeleton" key={index} aria-hidden="true"><span/><div><i/><i/><i/></div><b/></div>)}</>;
}

function MoreResults({props,onLoadMore}: {props:DiscoveryExplorerProps;onLoadMore:()=>void}) {
  if (props.hasMore===undefined&&!props.loadingMore&&!props.moreError) return null;
  const canLoadMore=Boolean(props.onLoadMore&&(props.hasMore||props.moreError||props.loadingMore));
  return <div className="dx-more-results" aria-label="More discovery results">
    {props.moreError&&!props.loadingMore&&<p className="dx-more-error" role="alert">{props.moreError}</p>}
    {canLoadMore?<>
      <button type="button" className="button dx-more-button" onClick={onLoadMore} disabled={props.loadingMore}>
        {props.loadingMore?<LoaderCircle size={15} className="spin" aria-hidden="true"/>:<ArrowDown size={15} aria-hidden="true"/>}
        {props.loadingMore?'Loading more places…':props.moreError?'Try loading more places again':'Show more places'}
      </button>
      <p className="dx-more-hint" role="status">{props.loadingMore?'Your places stay here while more load.':'Explore more when you’re ready.'}</p>
    </>:props.hasMore===false&&props.results.length>0?<div className="dx-results-end">
      <Check size={16} aria-hidden="true"/><strong>You’ve reached the end of these results.</strong>
      <p>Try another category or search a different area on the map.</p>
    </div>:null}
  </div>;
}

export default function DiscoveryExplorer(props:DiscoveryExplorerProps) {
  const inputId=useId(),list=useRef<HTMLDivElement>(null),listTitle=useRef<HTMLParagraphElement>(null);
  const [now,setNow]=useState(()=>new Date());
  useEffect(()=>{
    const refreshClock=()=>setNow(new Date());
    const timer=window.setInterval(refreshClock,60_000);
    const onVisibility=()=>{if(document.visibilityState==='visible')refreshClock();};
    document.addEventListener('visibilitychange',onVisibility);
    return ()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisibility);};
  },[]);
  const wasDetails=useRef(false),restoringScroll=useRef(false);
  const resultsKey=props.results.map(result=>result.place.id).join(',');
  useLayoutEffect(()=>{
    const shouldFocus=wasDetails.current;
    wasDetails.current=!!props.selectedResult;
    const element=list.current;
    if (props.selectedResult||props.loading||!element) return;
    const savedTop=props.scrollTop;
    let frame=0,observer:ResizeObserver|undefined;
    restoringScroll.current=true;
    const restore=()=>{
      // A native dialog has no scroll range until its parent's effect opens it.
      if (!element.clientHeight) return;
      element.scrollTop=savedTop;
      if (shouldFocus) listTitle.current?.focus({preventScroll:true});
      restoringScroll.current=false;
      observer?.disconnect();
    };
    if (element.clientHeight) restore();
    else {
      observer=new ResizeObserver(restore);
      observer.observe(element);
      frame=requestAnimationFrame(restore);
    }
    return ()=>{cancelAnimationFrame(frame);observer?.disconnect();restoringScroll.current=false;};
  },[!!props.selectedResult,resultsKey,props.loading]);
  const select=(result:DiscoveryResult)=>{props.onScrollTop(list.current?.scrollTop??0);props.onSelect(result);};
  function loadMore(){
    if(props.loadingMore||!props.onLoadMore)return;
    props.onScrollTop(list.current?.scrollTop??props.scrollTop);
    // Keep the scroll surface focused as new cards appear before the footer.
    list.current?.focus({preventScroll:true});
    props.onLoadMore();
  }
  function submit(event:FormEvent){event.preventDefault();props.onScrollTop(0);props.onSearch();}
  const city=props.destination.split(',')[0];
  return <div className={`dx-explorer ${props.selectedResult?'dx-explorer-detail':''}`}>
    {props.selectedResult?<DetailView result={props.selectedResult} props={props} now={now}/>:<>
      <div className="dx-header">
        <div className="dx-title-row"><div><span className="dx-eyebrow">A little room to explore</span><h2>Discover {city}</h2></div>{props.onClose&&<button type="button" className="icon-button" onClick={props.onClose} aria-label="Close discovery"><X size={17}/></button>}</div>
        <form className="dx-search" onSubmit={submit}>
          <label htmlFor={inputId}>Find a place or something you love</label>
          <div><Search size={16} aria-hidden="true"/><input id={inputId} type="search" value={props.query} onChange={event=>props.setQuery(event.target.value)} placeholder="Museums, parks, coffee…" maxLength={240}/><button type="submit" aria-label="Search places" disabled={props.loading}>{props.loading?<LoaderCircle size={16} className="spin"/>:<ArrowRight size={16}/>}</button></div>
        </form>
        <div className="dx-filters" role="group" aria-label="Place category">{filters.map(({value,label})=><button type="button" key={value} aria-pressed={props.category===value} onClick={()=>{props.onScrollTop(0);props.onCategory(value);}}>{label}</button>)}</div>
        {props.category==='indoor'&&<div className="dx-area-scope"><span><Umbrella size={12}/>Indoor ideas · check each venue’s details</span><button type="button" onClick={()=>props.onCategory('all')} aria-label="Clear indoor ideas filter"><X size={12}/>Clear</button></div>}
        {props.scope==='area'&&<div className="dx-area-scope"><span><MapPin size={12}/>{props.loading?'Searching this map area':'Results in this map area'}</span><button type="button" onClick={props.onBackToDestination}>Back to {city}</button></div>}
      </div>
      <div className="dx-results" ref={list} tabIndex={0} role="region" aria-label="Discovery results" onScroll={event=>{if(!restoringScroll.current&&!props.loading)props.onScrollTop(event.currentTarget.scrollTop);}} aria-busy={props.loading||props.loadingMore}>
        {props.loading?<LoadingCards/>:props.error?<div className="dx-empty" role="alert"><MapPin size={28}/><h3>A small detour</h3><p>{props.error}</p><button type="button" className="button" onClick={props.onSearch}>Try again<ArrowRight size={14}/></button></div>:props.searched?<>
          <p ref={listTitle} tabIndex={-1} className="dx-result-count" role="status">{props.results.length} {props.results.length===1?'place':'places'} to explore{props.scope==='area'?' in this area':''}</p>
          {props.results.length===0?<div className="dx-empty"><Search size={28}/><h3>No places found here</h3><p>Try a different category, a specific place name, or a wider area on the map.</p>{props.scope==='area'&&<button type="button" className="button" onClick={props.onBackToDestination}>Search {city}<ArrowRight size={14}/></button>}</div>:props.results.map(result=><ResultCard key={result.place.id} result={result} props={props} onSelect={()=>select(result)} now={now}/>)}
          <MoreResults props={props} onLoadMore={loadMore}/>
        </>:<div className="dx-welcome"><span className="dx-welcome-mark"><Compass size={29}/></span><span className="dx-eyebrow">Make the day your own</span><h3>Find your next favourite.</h3><p>A museum to explore, a park to unwind in, or a café worth the detour. Start exploring {city}.</p><div className="dx-suggestions">{filters.filter(filter=>filter.value!=='all').map(({value,label,icon:Icon})=><button type="button" key={value} onClick={()=>props.onCategory(value)}><Icon size={17}/><span>{label}</span><ArrowRight size={14}/></button>)}</div><p className="dx-map-tip"><MapPin size={13}/>Or move the map, then choose “Search this area”.</p></div>}
      </div>
    </>}
    <footer className="dx-footer">{!props.selectedResult&&props.onCustom&&<button type="button" className="dx-custom" onClick={props.onCustom}><Plus size={13}/>Add a custom place</button>}<span className="dx-google-brand">Google Maps</span><span className="dx-legal"><a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a><span>·</span><a href="/terms.html" target="_blank" rel="noreferrer">Terms</a></span></footer>
  </div>;
}
