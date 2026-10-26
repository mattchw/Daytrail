import {Car,ChevronDown,Footprints,TrainFront} from 'lucide-react';
import type {Journey,Mode} from '../model';
const names:Record<Mode,string>={walk:'Walk',transit:'Transit',drive:'Drive'};
export default function TravelLeg({leg,onChange,to,readOnly=false}:{leg:Journey;onChange:(mode:Mode)=>void;to:string;readOnly?:boolean}){
  const Icon=leg.mode==='walk'?Footprints:leg.mode==='transit'?TrainFront:Car;
  const reason=leg.status==='loading'?'Calculating journey…':leg.reason||'Journey estimate unavailable';
  return <div className={`travel-leg planner-leg ${leg.mode} ${leg.min===null?'unknown':''}`}>
    <span className="leg-line"/>
    {readOnly?<span className="journey-mode-static"><Icon size={14}/>{names[leg.mode]}</span>:<label className="journey-mode-picker"><Icon size={14}/><select aria-label={`Transport to ${to}`} value={leg.mode} onChange={e=>onChange(e.target.value as Mode)}><option value="walk">Walk</option><option value="transit">Transit</option><option value="drive">Drive</option></select><ChevronDown size={12}/></label>}
    <span className="travel-text" title={leg.warning||leg.reason}>{leg.min===null?reason:`${leg.min} min · ${leg.km} km`}</span>
  </div>;
}
