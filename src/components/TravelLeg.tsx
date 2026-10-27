import {Car,ChevronDown,Footprints,TrainFront,Plane} from 'lucide-react';
import type {Journey,Mode} from '../model';
const names:Record<Mode,string>={walk:'Walk',transit:'Transit',drive:'Drive',flight:'Flight'};
export default function TravelLeg({leg,onChange,to,readOnly=false,disabled=false}:{leg:Journey;onChange:(mode:Mode)=>void;to:string;readOnly?:boolean;disabled?:boolean}){
  const Icon=leg.mode==='flight'?Plane:leg.mode==='walk'?Footprints:leg.mode==='transit'?TrainFront:Car;
  const loading=leg.status==='loading';
  const reason=loading?'Calculating journey…':leg.reason||'Journey estimate unavailable';
  const label=loading?'Calculating…':leg.min===null?reason:leg.mode==='flight'?`${leg.min} min · scheduled flight`:`${leg.min} min · ${leg.km} km`;
  return <div className={`travel-leg planner-leg ${leg.mode} ${loading?'is-calculating':leg.min===null?'unknown':'is-estimated'}`} aria-busy={loading||undefined}>
    <span className="leg-line"/>
    {readOnly?<span className="journey-mode-static"><Icon size={14}/>{names[leg.mode]}</span>:<label className="journey-mode-picker"><Icon size={14}/><select disabled={disabled} aria-busy={disabled||undefined} aria-label={`Transport to ${to}`} value={leg.mode} onChange={e=>onChange(e.target.value as Mode)}><option value="walk">Walk</option><option value="transit">Transit</option><option value="drive">Drive</option><option value="flight">Flight</option></select><ChevronDown size={12}/></label>}
    <span className="travel-text" title={leg.warning||leg.reason||label} aria-label={loading?reason:undefined}>{label}</span>
    {leg.mode==='flight'&&leg.warning&&leg.warning!=='Scheduled flight; not live status.'&&<span className="flight-transfer-warning" role="status">{leg.warning}</span>}
  </div>;
}
