import { LabelDetector, grayPixels, highpass, matchReference, scaleRect, capsuleAlpha, type GrayFrame, type Detection } from './core';

// This worker processes one frame at a time. The caller never queues an unbounded
// backlog; raw reference frames are bounded by both age and count.
interface Reference { bitmap: ImageBitmap; gray: GrayFrame; detection: Detection; time: number }
const scope = self as unknown as { onmessage: ((event: MessageEvent<{bitmap:ImageBitmap;time:number;startedAt:number;generation:number}>)=>void)|null; postMessage: (message:unknown,transfer:Transferable[])=>void };
const analysis = new OffscreenCanvas(1,1);
const analysisContext = analysis.getContext('2d',{willReadFrequently:true})!;
const output = new OffscreenCanvas(1,1);
const outputContext = output.getContext('2d')!;
const patchCanvas = new OffscreenCanvas(1,1);
const patchContext = patchCanvas.getContext('2d',{willReadFrequently:true})!;
let detector:LabelDetector, reverseDetector:LabelDetector;
let preferredReverse=false;
let references:Reference[]=[];
let lastStored=-Infinity;
let previousTime=-Infinity;
let previousGeneration=-1;
const THRESHOLD=.58;

scope.onmessage=({data:{bitmap,time,startedAt,generation}})=>{
  const start=performance.now();
  let retained=false;
  try {
    const width=bitmap.width, height=bitmap.height;
    if(width*height>3840*2160)throw new Error('实验处理最大支持 4K 输入');
    const referenceLimit=Math.max(1,Math.min(14,Math.floor(96*1024*1024/(width*height*4))));
    if(width!==output.width||height!==output.height||time<previousTime||generation!==previousGeneration) {
      for(const ref of references)ref.bitmap.close();references=[];lastStored=-Infinity;
      output.width=width;output.height=height;
      analysis.width=Math.min(960,width);analysis.height=Math.round(height*analysis.width/width);
      detector=new LabelDetector(analysis.width,analysis.height);
      reverseDetector=new LabelDetector(analysis.width,analysis.height,true);
      preferredReverse=false;
    }
    previousTime=time;previousGeneration=generation;
    analysisContext.drawImage(bitmap,0,0,analysis.width,analysis.height);
    const gray:GrayFrame={data:grayPixels(analysisContext.getImageData(0,0,analysis.width,analysis.height).data),width:analysis.width,height:analysis.height};
    const filtered=highpass(gray.data,gray.width,gray.height);
    let detection=(preferredReverse?reverseDetector:detector).detect(gray,filtered);
    if(detection.score<THRESHOLD) {
      const alternate=(preferredReverse?detector:reverseDetector).detect(gray,filtered);
      if(alternate.score>detection.score){detection=alternate;if(alternate.score>=THRESHOLD)preferredReverse=!preferredReverse;}
    }
    while(references.length&&(time-references[0].time>4||references.length>referenceLimit))references.shift()!.bitmap.close();
    outputContext.drawImage(bitmap,0,0);
    let state:'repaired'|'searching'|'waiting'|'motion'='searching';
    let alignmentError:number|null=null;
    if(detection.score>=THRESHOLD) {
      state='waiting';
      let best:{ref:Reference;dx:number;dy:number;error:number}|null=null;
      // A short rolling history is causal: never claims future-frame offline quality.
      const candidates=references.filter(r=>time-r.time>.15).slice().reverse();
      for(const ref of candidates) {
        const match=matchReference(gray,ref.gray,detection.rect,ref.detection.rect);
        if(match&&(!best||match.error<best.error))best={ref,...match};
        if(best&&best.error<1.5)break;
      }
      if(best) {
        alignmentError=best.error;
        state='motion';
        if(best.error<=9) {
          const scale=width/analysis.width, rect=scaleRect(detection.rect,scale);
          const x=Math.max(0,Math.floor(rect.x-3)),y=Math.max(0,Math.floor(rect.y-3));
          const w=Math.min(width-x,Math.ceil(rect.x+rect.width+3)-x),h=Math.min(height-y,Math.ceil(rect.y+rect.height+3)-y);
          if(w>0&&h>0) {
            patchCanvas.width=w;patchCanvas.height=h;
            patchContext.drawImage(best.ref.bitmap,x+best.dx*scale,y+best.dy*scale,w,h,0,0,w,h);
            const patch=patchContext.getImageData(0,0,w,h);
            for(let py=0;py<h;py++)for(let px=0;px<w;px++)patch.data[(py*w+px)*4+3]=Math.round(255*capsuleAlpha(x+px,y+py,rect,2));
            patchContext.putImageData(patch,0,0);
            outputContext.drawImage(patchCanvas,x,y);
            state='repaired';
          }
        }
      }
      if(time-lastStored>=.28) {
        // Always retain ORIGINAL input, never recursively repaired output.
        while(references.length>=referenceLimit)references.shift()!.bitmap.close();
        references.push({bitmap,gray,detection,time});lastStored=time;retained=true;
      }
    }
    const rendered=output.transferToImageBitmap();
    scope.postMessage({bitmap:rendered,startedAt,generation,state,score:detection.score,alignmentError,elapsedMs:performance.now()-start},[rendered]);
  } catch(error) {
    scope.postMessage({error:error instanceof Error?error.message:String(error)},[]);
  } finally {
    if(!retained)bitmap.close();
  }
};
