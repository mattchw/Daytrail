import type {Activity,Exposure,MealIntent,Place} from '../model';
/** Editable planning estimates for the bundled Kyoto example, not provider measurements. */
export const SAMPLE_VISIT_TRAITS:Readonly<Record<string,{walkingMeters:number;meal:MealIntent;exposure:Exposure}>>={
 fushimi:{walkingMeters:2500,meal:'none',exposure:'outdoor'},kiyomizu:{walkingMeters:1000,meal:'none',exposure:'mixed'},
 sannenzaka:{walkingMeters:800,meal:'none',exposure:'outdoor'},nishiki:{walkingMeters:500,meal:'meal',exposure:'mixed'},
 gion:{walkingMeters:1200,meal:'none',exposure:'outdoor'},pontocho:{walkingMeters:100,meal:'meal',exposure:'indoor'},
 bamboo:{walkingMeters:1000,meal:'none',exposure:'outdoor'},tenryuji:{walkingMeters:900,meal:'none',exposure:'mixed'},
 arashilunch:{walkingMeters:100,meal:'meal',exposure:'indoor'},kinkakuji:{walkingMeters:1000,meal:'none',exposure:'outdoor'},
 tea:{walkingMeters:0,meal:'snack',exposure:'indoor'},heian:{walkingMeters:800,meal:'none',exposure:'mixed'},
 ginkakuji:{walkingMeters:1000,meal:'none',exposure:'outdoor'},nanzenji:{walkingMeters:1200,meal:'none',exposure:'mixed'},
 philosopher:{walkingMeters:1800,meal:'none',exposure:'outdoor'},nijo:{walkingMeters:1500,meal:'none',exposure:'mixed'},
 railway:{walkingMeters:1500,meal:'none',exposure:'indoor'},tofukuji:{walkingMeters:1000,meal:'none',exposure:'mixed'},
 sanjusangendo:{walkingMeters:400,meal:'none',exposure:'indoor'},yasaka:{walkingMeters:600,meal:'none',exposure:'outdoor'},
 palace:{walkingMeters:1800,meal:'none',exposure:'mixed'},ramen:{walkingMeters:100,meal:'meal',exposure:'indoor'},
 demachi:{walkingMeters:500,meal:'snack',exposure:'mixed'},
};
export function visitTraits(activity:Activity,place?:Place){
 const sample=place&&!place.googlePlaceId?SAMPLE_VISIT_TRAITS[activity.placeId]:undefined;
 return {meal:activity.meal??sample?.meal??'none',walkingMeters:activity.walkingMeters??sample?.walkingMeters,
 exposure:activity.exposure??sample?.exposure??'unknown',walkingSource:activity.walkingMeters!==undefined?'user':sample?'sample':'unknown'} as const;
}

/** Preserve bundled estimates when an edit gives a sample place a trip-owned identity. */
export function retainSampleVisitTraits(activity:Activity,place:Place):void {
 const sample=!place.googlePlaceId?SAMPLE_VISIT_TRAITS[activity.placeId]:undefined;
 if(!sample)return;
 activity.meal??=sample.meal;
 activity.walkingMeters??=sample.walkingMeters;
 activity.exposure??=sample.exposure;
}
