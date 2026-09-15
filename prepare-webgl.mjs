import {existsSync,readFileSync,openSync,writeSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const dir=new URL('./Build/WebGL/Build/',import.meta.url);
const manifest=new URL('data-parts.json',dir);
if(existsSync(manifest)) {
 const m=JSON.parse(readFileSync(manifest,'utf8'));
 const target=new URL(m.file,dir), temp=new URL(m.file+'.assembling',dir);
 const hash=createHash('sha256'); let bytes=0; const fd=openSync(temp,'w');
 try { for(const part of m.parts) { const chunk=readFileSync(new URL(part,dir)); hash.update(chunk); bytes+=chunk.length; let offset=0; while(offset<chunk.length) offset+=writeSync(fd,chunk,offset,chunk.length-offset); } }
 finally { closeSync(fd); }
 if(bytes!==m.bytes || hash.digest('hex')!==m.sha256) { unlinkSync(temp); throw new Error('WebGL data checksum mismatch'); }
 renameSync(temp,target);
 console.log('WebGL data reconstructed and SHA-256 verified: '+bytes+' bytes');
}
