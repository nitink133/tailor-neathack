/** Plain-text structure only. Callers escape every field; no Markdown/HTML is executed. */
export type ReplyTextBlock = {kind:'paragraph';text:string}|{kind:'points';items:string[]};
export type ReplyBlock = ReplyTextBlock|{kind:'steps';start:number;items:{title:string;body:ReplyTextBlock[]}[]}|{kind:'references';lines:string[];unknownPlans:boolean};

const reference = (line:string)=>/^Sources:|^Plan availability for .+:|^.{1,160} is listed for:/i.test(line);
const marker = (line:string)=>/^(\d{1,3})[.)]\s+(.+)$/.exec(line);
const point = (line:string)=>/^(?:[-•])\s+(.+)$/.exec(line);
/** A bounded, one-level pass that preserves original wording and numbered order. */
export function replyBlocks(text:string, options:{groupReferences?:boolean}={}):ReplyBlock[]{
 const blocks:ReplyBlock[]=[];const references:string[]=[];
 const lines=text.replace(/\r\n?/g,'\n').split('\n').map(line=>line.trim());
 const sourceIndex=lines.findLastIndex(line=>/^Sources:/.test(line));
 const evidenceReply=/^Saved and verified as version |^\d+[.)] .+ — [A-Z_]+, (?:OK|ERROR), starts \+/m.test(text);
 const pricing='I don’t have verified prices, so I won’t quote any.';
 const footer=lines.slice(sourceIndex+1).filter(Boolean);
 const canonicalFooter=options.groupReferences!==false&&!evidenceReply&&sourceIndex>0&&footer.some(line=>/^Plan availability for .+:|^.{1,160} is listed for:/.test(line))&&footer.every(line=>reference(line)||line===pricing);
 let steps:Extract<ReplyBlock,{kind:'steps'}>|undefined;
 let body:ReplyTextBlock[]|undefined;
 const append=(line:string)=>{
  const target=body??blocks;const bullet=point(line);
  if(bullet){const previous=target.at(-1);if(previous?.kind==='points')previous.items.push(bullet[1]!);else target.push({kind:'points',items:[bullet[1]!]});}
  else target.push({kind:'paragraph',text:line});
 };
 for(const [index,line] of lines.entries()){
  if(!line)continue;
  if(canonicalFooter&&index>=sourceIndex&&reference(line)){references.push(line);steps=undefined;body=undefined;continue;}
  if(canonicalFooter&&index>sourceIndex&&line===pricing){steps=undefined;body=undefined;append(line);continue;}
  const numbered=marker(line);
  if(numbered){const n=Number(numbered[1]);if(!steps||n!==steps.start+steps.items.length){steps={kind:'steps',start:n,items:[]};blocks.push(steps);}const item={title:numbered[2]!,body:[] as ReplyTextBlock[]};steps.items.push(item);body=item.body;continue;}
  // Older code-composed capability replies used a title and labeled clauses on one line.
  // Split only that explicit legacy form; preserve every clause and its wording.
  if(steps?.items.at(-1)?.title.match(/ — [A-Z_]+, (?:OK|ERROR), starts \+/)&&/^(?:No step failed in this run\.|\d+ steps? failed:|Flagged as “Execution Failed”:)/.test(line)){steps=undefined;body=undefined;append(line);continue;}
  const legacy=/^([^:\n]{1,150}):\s+(.+)$/.exec(line);
  if(!body&&!point(line)&&legacy&&/\bLimits:|\bYou’d need:|\bIn this demo\b/.test(legacy[2]!)){
   const chunks=legacy[2]!.split(/\s+(?=Limits:|You’d need:|In this demo\b)/);
   const item={title:legacy[1]!,body:chunks.map(chunk=>({kind:'paragraph' as const,text:chunk}))};
   if(!steps){steps={kind:'steps',start:1,items:[]};blocks.push(steps);}steps.items.push(item);body=undefined;continue;
  }
  append(line);
 }
 if(references.length)blocks.push({kind:'references',lines:references,unknownPlans:references.some(line=>/^Plan availability for .+: unknown\./i.test(line))});
 return blocks;
}
