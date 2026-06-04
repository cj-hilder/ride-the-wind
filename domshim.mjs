// Minimal DOMParser shim for testing: supports getElementsByTagName,
// getAttribute, textContent, and a parsererror node for malformed XML.
// Sufficient for GPX (<trkpt lat lon><ele>..</ele></trkpt>), not general XML.
class El {
  constructor(tag){ this.tag=tag; this.attrs={}; this.children=[]; this.text=''; }
  getAttribute(n){ return n in this.attrs ? this.attrs[n] : null; }
  get textContent(){ return this.text; }
  getElementsByTagName(name){
    const out=[];
    const walk=(e)=>{ for(const c of e.children){ if(c.tag===name) out.push(c); walk(c);} };
    walk(this); return out;
  }
}
class Doc extends El { constructor(){ super('#document'); } }

function tokenize(xml){
  return xml.match(/<[^>]+>|[^<]+/g) || [];
}
export class DOMParser {
  parseFromString(xml){
    const doc=new Doc();
    // crude well-formedness: every < has a matching >
    if((xml.match(/</g)||[]).length !== (xml.match(/>/g)||[]).length){
      const err=new El('parsererror'); doc.children.push(err); return doc;
    }
    const stack=[doc];
    for(const tok of tokenize(xml)){
      if(tok.startsWith('<?')||tok.startsWith('<!')) continue;
      if(tok.startsWith('</')){ stack.pop(); continue; }
      if(tok.startsWith('<')){
        const self=tok.endsWith('/>');
        const inner=tok.slice(1, self?-2:-1).trim();
        const sp=inner.indexOf(' ');
        const tag= sp<0?inner:inner.slice(0,sp);
        const el=new El(tag);
        if(sp>=0){
          const attrRe=/(\w+)\s*=\s*"([^"]*)"/g; let m;
          while((m=attrRe.exec(inner))) el.attrs[m[1]]=m[2];
        }
        stack[stack.length-1].children.push(el);
        if(!self) stack.push(el);
      } else {
        const t=tok.trim();
        if(t && stack.length>1) stack[stack.length-1].text += t;
      }
    }
    return doc;
  }
}
