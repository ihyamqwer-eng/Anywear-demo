import label from './label-template.json';

export interface Rect { x: number; y: number; width: number; height: number }
export interface Detection { rect: Rect; score: number }
export interface GrayFrame { data: Float32Array; width: number; height: number }
interface Sample { dx: number; dy: number; value: number }

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
    this.samples=[];
    // Uniform sampling is important: selecting only white glyph pixels gives false positives.
    for (let y=1;y<this.th-1;y+=2) for (let x=2;x<this.tw-2;x+=2) this.samples.push({dx:x,dy:y,value:hp[y*this.tw+x]});
    this.coarse=this.samples.filter((_,i)=>i%3===0);
    this.sampleNorm=this.samples.reduce((sum,s)=>sum+s.value*s.value,0);
    this.coarseNorm=this.coarse.reduce((sum,s)=>sum+s.value*s.value,0);
  }
  detect(frame: GrayFrame, filtered?:Float32Array): Detection {
    const hp=filtered||highpass(frame.data,frame.width,frame.height);
    const score=(x:number,y:number,samples:Sample[])=>{
      if (x<0||y<0||x+this.tw>this.width||y+this.th>this.height) return -1;
      let dot=0, norm=0;
      const templateNorm=samples===this.coarse?this.coarseNorm:this.sampleNorm;
      for (let i=0;i<samples.length;i++) {
        const s=samples[i], value=hp[(y+s.dy)*this.width+x+s.dx];
        dot+=s.value*value;norm+=value*value;
      }
      return norm>samples.length*2 ? dot/Math.sqrt(norm*templateNorm) : -1;
    };
    let best={x:0,y:0,score:-1};
    const consider=(x:number,y:number)=>{const s=score(x,y,this.samples);if(s>best.score)best={x,y,score:s};};
    if (this.previous) {
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)consider(this.previous.x+dx,this.previous.y+dy);
    }
    // The badge jumps; never keep a stale rectangle solely because it was seen previously.
    if (best.score<.68) {
      const candidates: {x:number;y:number;score:number}[]=[];
      for(let y=0;y<=this.height-this.th;y+=2)for(let x=0;x<=this.width-this.tw;x+=2){
        const s=score(x,y,this.coarse);
        if(s>.20)candidates.push({x,y,score:s});
      }
      candidates.sort((a,b)=>b.score-a.score);
      for(const p of candidates.slice(0,256))for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)consider(p.x+dx,p.y+dy);
    }
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
export function matchReference(current:GrayFrame,reference:GrayFrame,rect:Rect,referenceRect:Rect):{dx:number;dy:number;error:number}|null {
  if(overlaps(rect,referenceRect,10))return null;
  const {width,height}=current;
  const x0=Math.max(1,Math.floor(rect.x-12)), y0=Math.max(1,Math.floor(rect.y-12));
  const x1=Math.min(width-2,Math.ceil(rect.x+rect.width+12)), y1=Math.min(height-2,Math.ceil(rect.y+rect.height+12));
  const points:{x:number;y:number}[]=[];
  for(let y=y0;y<=y1;y+=3)for(let x=x0;x<=x1;x+=3){
    if(x>rect.x-2&&x<rect.x+rect.width+2&&y>rect.y-2&&y<rect.y+rect.height+2)continue;
    points.push({x,y});
  }
  if(points.length<24)return null;
  const evaluate=(dx:number,dy:number)=>{
    const shifted={...rect,x:rect.x+dx,y:rect.y+dy};
    if(overlaps(shifted,referenceRect,4)||shifted.x<1||shifted.y<1||shifted.x+rect.width>=width-1||shifted.y+rect.height>=height-1)return Infinity;
    let sum=0, count=0;
    for(const p of points){
      const sx=p.x+dx,sy=p.y+dy;
      if(sx<0||sx>=width||sy<0||sy>=height||(sx>=referenceRect.x-2&&sx<=referenceRect.x+referenceRect.width+2&&sy>=referenceRect.y-2&&sy<=referenceRect.y+referenceRect.height+2&&capsuleAlpha(sx,sy,referenceRect)>.01))continue;
      const delta=Math.abs(current.data[p.y*width+p.x]-reference.data[sy*width+sx]);
      sum+=delta;count++;
    }
    return count>=points.length*.85 ? sum/count : Infinity;
  };
  let best={dx:0,dy:0,error:evaluate(0,0)};
  for(let dy=-9;dy<=9;dy+=3)for(let dx=-9;dx<=9;dx+=3){const error=evaluate(dx,dy);if(error<best.error)best={dx,dy,error};}
  const {dx,dy}=best;
  for(let oy=-2;oy<=2;oy++)for(let ox=-2;ox<=2;ox++){const error=evaluate(dx+ox,dy+oy);if(error<best.error)best={dx:dx+ox,dy:dy+oy,error};}
  return Number.isFinite(best.error)?best:null;
}
