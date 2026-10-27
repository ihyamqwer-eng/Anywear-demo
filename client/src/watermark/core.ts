import label from './label-template.json';

export interface Rect { x: number; y: number; width: number; height: number }
export interface Detection { rect: Rect; score: number }
export interface GrayFrame { data: Float32Array; width: number; height: number }
interface Sample { dx: number; dy: number; value: number }
interface Candidate { x: number; y: number; score: number; anchorX?: number; anchorY?: number }
const DENSE_RESCAN_INTERVAL_FRAMES=3;
const MAX_REFINEMENT_CANDIDATES=96;
const REFINEMENT_RADIUS=3;

export function grayPixels(rgba: Uint8ClampedArray): Float32Array {
  const gray = new Float32Array(rgba.length / 4);
  for (let i = 0; i < gray.length; i++) gray[i] = .299 * rgba[i*4] + .587 * rgba[i*4+1] + .114 * rgba[i*4+2];
  return gray;
}

export function highpass(data: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(data.length);
  const integral = new Float32Array((width+1)*(height+1));
  for (let y=0;y<height;y++) {
    let row=0;
    for (let x=0;x<width;x++) { row+=data[y*width+x]; integral[(y+1)*(width+1)+x+1]=integral[y*(width+1)+x+1]+row; }
  }
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const x0=Math.max(0,x-2), x1=Math.min(width,x+3), y0=Math.max(0,y-2), y1=Math.min(height,y+3), stride=width+1;
    const sum=integral[y1*stride+x1]-integral[y0*stride+x1]-integral[y1*stride+x0]+integral[y0*stride+x0];
    out[y*width+x]=data[y*width+x]-sum/((x1-x0)*(y1-y0));
  }
  return out;
}

export class LabelDetector {
  private readonly samples: Sample[];
  private readonly coarse: Sample[];
  private readonly sampleNorm: number;
  private readonly coarseNorm: number;
  private readonly tw: number;
  private readonly th: number;
  private readonly scale: number;
  private previous: { x: number; y: number } | null = null;
  private frameIndex=0;
  constructor(private readonly width: number, private readonly height: number, private readonly mirrored = false) {
    this.scale=height/label.referenceHeight;
    this.tw=Math.round(label.textWidth*this.scale); this.th=Math.round(label.textHeight*this.scale);
    const template=new Float32Array(this.tw*this.th);
    for (let y=0;y<this.th;y++) for (let x=0;x<this.tw;x++) {
      const sx=(x+.5)*label.textWidth/this.tw-.5, sy=(y+.5)*label.textHeight/this.th-.5;
      const ix=Math.max(0,Math.floor(sx)), iy=Math.max(0,Math.floor(sy)), fx=sx-ix, fy=sy-iy;
      const at=(xx:number,yy:number)=>label.gray[Math.min(label.textHeight-1,yy)*label.textWidth+Math.min(label.textWidth-1,xx)];
      template[y*this.tw+x]=(at(ix,iy)*(1-fx)+at(ix+1,iy)*fx)*(1-fy)+(at(ix,iy+1)*(1-fx)+at(ix+1,iy+1)*fx)*fy;
    }
    if (mirrored) for(let y=0;y<this.th;y++) template.subarray(y*this.tw,(y+1)*this.tw).reverse();
    const hp=highpass(template,this.tw,this.th);
    const rawSamples: Sample[]=[];
    // Uniform sampling is important: selecting only white glyph pixels gives false positives.
    for (let y=1;y<this.th-1;y+=2) for (let x=2;x<this.tw-2;x+=2) rawSamples.push({dx:x,dy:y,value:hp[y*this.tw+x]});
    this.samples=rawSamples;
    this.coarse=rawSamples.filter((_,i)=>i%4===0);
    this.sampleNorm=this.samples.reduce((sum,s)=>sum+s.value*s.value,0);
    this.coarseNorm=this.coarse.reduce((sum,s)=>sum+s.value*s.value,0);
  }
  detect(frame: GrayFrame, filtered?:Float32Array): Detection {
    this.frameIndex++;
    const hp=filtered||highpass(frame.data,frame.width,frame.height);
    const score=(x:number,y:number,samples:Sample[],templateNorm:number)=>{
      if (x<0||y<0||x+this.tw>this.width||y+this.th>this.height) return -1;
      let dot=0, norm=0;
      for (let i=0;i<samples.length;i++) {
        const s=samples[i], value=hp[(y+s.dy)*this.width+x+s.dx];
        dot+=s.value*value;norm+=value*value;
      }
      return norm>samples.length*2 ? Math.max(-1,Math.min(1,dot/Math.sqrt(norm*templateNorm))) : -1;
    };
    const refine=(origin:Candidate,radius=REFINEMENT_RADIUS):Candidate=>{
      let best={...origin,score:score(origin.x,origin.y,this.samples,this.sampleNorm)};
      for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++){
        const x=origin.x+dx,y=origin.y+dy,s=score(x,y,this.samples,this.sampleNorm);
        if(s>best.score)best={x,y,score:s};
      }
      return best;
    };
    let best:Candidate|null=null;
    if (this.previous) {
      let local={x:this.previous.x,y:this.previous.y,score:-1};
      for(let dy=-12;dy<=12;dy+=4)for(let dx=-24;dx<=24;dx+=4){
        const x=this.previous.x+dx,y=this.previous.y+dy,s=score(x,y,this.coarse,this.coarseNorm);
        if(s>local.score)local={x,y,score:s};
      }
      best=refine(local);
    }
    // The badge jumps; never keep a stale rectangle solely because it was seen previously.
    const trackingLost=!best||best.score<.68;
    if (trackingLost||this.frameIndex%20===0) {
      const peaks:Candidate[]=[];
      const scanStep=trackingLost||this.frameIndex===1||this.frameIndex%DENSE_RESCAN_INTERVAL_FRAMES===0?2:4;
      const separationX=Math.min(REFINEMENT_RADIUS+1,Math.max(2,Math.round(this.tw*.04)));
      const separationY=Math.min(REFINEMENT_RADIUS+1,Math.max(2,Math.round(this.th*.1)));
      for(let y=0;y<=this.height-this.th;y+=scanStep)for(let x=0;x<=this.width-this.tw;x+=scanStep){
        const value=score(x,y,this.coarse,this.coarseNorm);
        if(value<.16)continue;
        const nearby=peaks.findIndex(p=>Math.abs((p.anchorX??p.x)-x)<separationX&&Math.abs((p.anchorY??p.y)-y)<separationY);
        if(nearby>=0){if(value>peaks[nearby].score)peaks[nearby]={...peaks[nearby],x,y,score:value};continue;}
        if(peaks.length<MAX_REFINEMENT_CANDIDATES){peaks.push({x,y,score:value,anchorX:x,anchorY:y});continue;}
        let weakest=0;
        for(let i=1;i<peaks.length;i++)if(peaks[i].score<peaks[weakest].score)weakest=i;
        if(value>peaks[weakest].score)peaks[weakest]={x,y,score:value,anchorX:x,anchorY:y};
      }
      peaks.sort((a,b)=>b.score-a.score);
      for(const peak of peaks){
        const candidate=refine(peak);
        if(!best||candidate.score>best.score)best=candidate;
      }
    }
    if(!best)best={x:0,y:0,score:-1};
    this.previous=best.score>.5?{x:best.x,y:best.y}:null;
    return {score:best.score,rect:{x:best.x+(this.mirrored ? -(label.badgeWidth+label.badgeOffsetX-label.textWidth) : label.badgeOffsetX)*this.scale,y:best.y+label.badgeOffsetY*this.scale,
      width:label.badgeWidth*this.scale,height:label.badgeHeight*this.scale}};
  }
}

export function overlaps(a:Rect,b:Rect,padding=3):boolean {
  return a.x<b.x+b.width+padding && a.x+a.width+padding>b.x && a.y<b.y+b.height+padding && a.y+a.height+padding>b.y;
}
export function scaleRect(rect:Rect,scale:number):Rect {
  return {x:rect.x*scale,y:rect.y*scale,width:rect.width*scale,height:rect.height*scale};
}
export function capsuleAlpha(x:number,y:number,rect:Rect,feather=2):number {
  const r=rect.height/2, dx=Math.max(rect.x+r-x,x-(rect.x+rect.width-r),0),dy=y-(rect.y+r);
  return Math.max(0,Math.min(1,(1.5-(Math.hypot(dx,dy)-r))/feather));
}

/** Conservative translation alignment. Reject motion/occlusion rather than invent face detail. */
export function matchReference(current:GrayFrame,reference:GrayFrame,rect:Rect,referenceRect:Rect|null):{dx:number;dy:number;error:number}|null {
  if(referenceRect&&overlaps(rect,referenceRect,10))return null;
  const {width,height}=current;
  const x0=Math.max(1,Math.floor(rect.x-12)), y0=Math.max(1,Math.floor(rect.y-12));
  const x1=Math.min(width-2,Math.ceil(rect.x+rect.width+12)), y1=Math.min(height-2,Math.ceil(rect.y+rect.height+12));
  const points:{x:number;y:number}[]=[];
  for(let y=y0;y<=y1;y+=3)for(let x=x0;x<=x1;x+=3){
    if(x>rect.x-2&&x<rect.x+rect.width+2&&y>rect.y-2&&y<rect.y+rect.height+2)continue;
    points.push({x,y});
  }
  if(points.length<24)return null;
  const overlapsReferenceWatermark=(x:number,y:number,padding:number)=>referenceRect!==null
    &&x>=referenceRect.x-padding&&x<=referenceRect.x+referenceRect.width+padding
    &&y>=referenceRect.y-padding&&y<=referenceRect.y+referenceRect.height+padding
    &&capsuleAlpha(x,y,referenceRect)>.01;
  const evaluate=(dx:number,dy:number,requireValidGain=true)=>{
    const shifted={...rect,x:rect.x+dx,y:rect.y+dy};
    if((referenceRect&&overlaps(shifted,referenceRect,4))||shifted.x<1||shifted.y<1||shifted.x+rect.width>=width-1||shifted.y+rect.height>=height-1)return Infinity;
    let sumCurrent=0,sumReference=0,sumReferenceSquared=0,sumCross=0,count=0;
    for(const p of points){
      const sx=p.x+dx,sy=p.y+dy;
      if(sx<0||sx>=width||sy<0||sy>=height||overlapsReferenceWatermark(sx,sy,2))continue;
      const currentValue=current.data[p.y*width+p.x],referenceValue=reference.data[sy*width+sx];
      sumCurrent+=currentValue;sumReference+=referenceValue;sumReferenceSquared+=referenceValue*referenceValue;sumCross+=currentValue*referenceValue;count++;
    }
    if(count<points.length*.85)return Infinity;
    const variance=sumReferenceSquared-sumReference*sumReference/count;
    const gain=variance>count*16?(sumCross-sumCurrent*sumReference/count)/variance:1;
    if(requireValidGain&&(gain<.65||gain>1.5))return Infinity;
    const offset=(sumCurrent-gain*sumReference)/count;
    let residual=0;
    for(const p of points){
      const sx=p.x+dx,sy=p.y+dy;
      if(sx<0||sx>=width||sy<0||sy>=height||overlapsReferenceWatermark(sx,sy,2))continue;
      residual+=Math.abs(current.data[p.y*width+p.x]-(gain*reference.data[sy*width+sx]+offset));
    }
    return residual/count;
  };
  let best={dx:0,dy:0,error:evaluate(0,0,false)};
  for(let dy=-18;dy<=18;dy+=6)for(let dx=-18;dx<=18;dx+=6){const error=evaluate(dx,dy,false);if(error<best.error)best={dx,dy,error};}
  const coarse=best;
  best={dx:coarse.dx,dy:coarse.dy,error:Infinity};
  for(let oy=-3;oy<=3;oy++)for(let ox=-3;ox<=3;ox++){
    const dx=coarse.dx+ox,dy=coarse.dy+oy,error=evaluate(dx,dy);
    if(error<best.error)best={dx,dy,error};
  }
  return Number.isFinite(best.error)?best:null;
}
