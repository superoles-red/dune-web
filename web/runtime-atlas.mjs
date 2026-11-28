// Lossless transport only: each canvas contains the unchanged original PNG crop.
import {loadAssetImage,loadAssetJSON} from './asset-loader.mjs?v=20261113-feedback';

export function atlasEntries(manifest,expected,width,height){
 if(manifest?.version!==1||manifest.path!=='runtime-atlas.png'||manifest.width!==width||manifest.height!==height||width<1||height<1||width>2048||height>2048)throw Error('Native graphics atlas dimensions differ');
 const entries=[];
 for(const [key,path]of expected){
  const entry=manifest.assets?.[key],r=entry?.rect;
  if(entry?.source!==path||!Array.isArray(r)||r.length!==4||!r.every(Number.isSafeInteger)||r[0]<0||r[1]<0||r[2]<1||r[3]<1||r[0]+r[2]>width||r[1]+r[3]>height)throw Error('Missing native graphics crop: '+key);
  entries.push([key,path,r]);
 }
 if(entries.length!==Object.keys(manifest.assets||{}).length)throw Error('Native graphics atlas catalogue differs');
 return entries;
}

export async function loadRuntimeAtlas(expected,{onProgress=()=>{},doc=globalThis.document,bitmapFactory=globalThis.createImageBitmap}={}){
 const base=new URL('./ui-assets/',import.meta.url),atlasUrl=new URL('runtime-atlas.png?v=20261113-feedback',base);
 const loadAtlas=async()=>{
  // Decode the whole atlas through a Blob. WebKit may reject <img>.decode() for a
  // large sheet and then hand back an undecoded image, so canvas crops came out
  // blank and every packed UI part (buttons, frames, glyphs) was invisible.
  try{
   const response=await fetch(atlasUrl,{cache:'no-store'});
   if(!response.ok)throw Error('atlas HTTP '+response.status);
   const blob=await response.blob();
   if(typeof bitmapFactory==='function')return await bitmapFactory.call(globalThis,blob);
  }catch{/* fall back to the <img> loader below */}
  return loadAssetImage(atlasUrl);
 };
 const [manifest,image]=await Promise.all([
  loadAssetJSON(new URL('runtime-atlas.json?v=20261113-feedback',base)),
  loadAtlas(),
 ]);
 const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
 const entries=atlasEntries(manifest,expected,width,height),images=new Map();
 try{for(const [key,path,[x,y,w,h]]of entries){
  // WebKit/Safari accepts the cropped createImageBitmap(source,sx,sy,sw,sh)
  // overload but returns empty crops, so packed button/frame/glyph parts were
  // invisible on iPhone. Crop through a canvas on every engine instead.
  const crop=doc.createElement('canvas');crop.width=w;crop.height=h;
  const context=crop.getContext('2d',{willReadFrequently:true});if(!context)throw Error('Native graphics canvas is unavailable');
  context.imageSmoothingEnabled=false;context.drawImage(image,x,y,w,h,0,0,w,h);
  // Original identity is retained for the existing tinted-glyph cache.
  images.set(key,crop);crop.src=new URL('./'+path,import.meta.url).href;
  onProgress({stage:'graphics',loaded:images.size,total:entries.length});
 }}catch(error){for(const crop of images.values())crop.close?.();throw error;}
 return images;
}
