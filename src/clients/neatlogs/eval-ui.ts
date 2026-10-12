/** Isolated native eval surfaces. No requests, persistence, providers or session authority.
 * The owning client supplies already-authorized data and handles every action.
 * Reference pixels: /tmp/tailor-evals-visual-review/visual-review-manifest.json.
 */
import type { EvaluationDetail } from './eval-contract.ts';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const paths: Record<string, string> = {
  eval: 'M9 3h6v4H9zM7 5H5v16h11M17 9V6h-2M8 11h5M8 15h3m3 3 2 2 5-6',
  badge: 'm12 2 3 2 4 1 1 4 2 3-2 3-1 4-4 1-3 2-3-2-4-1-1-4-2-3 2-3 1-4 4-1zM9 12l2 2 4-4',
  plus:'M12 4v16M4 12h16', close:'m6 6 12 12M18 6 6 18', down:'m7 10 5 5 5-5',
  filter:'M3 5h18l-7 8v6l-4 2v-8z', settings:'M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4',
  calendar:'M5 5h14v16H5zM5 10h14M8 3v4M16 3v4', eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  agent:'M9 3h6M12 3v3M6 8h12v11H6zM3 11v5M21 11v5M9 12h.1M15 12h.1M10 16h4', code:'m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16', back:'m14 6-6 6 6 6',
};
const measuredIcons: Record<string,string> = {"calendar": "<svg aria-hidden=\"true\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" color=\"currentColor\" data-slot=\"icon\"><path d=\"M16 2V6M8 2V6\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"></path><path d=\"M13 4H11C7.22876 4 5.34315 4 4.17157 5.17157C3 6.34315 3 8.22876 3 12V14C3 17.7712 3 19.6569 4.17157 20.8284C5.34315 22 7.22876 22 11 22H13C16.7712 22 18.6569 22 19.8284 20.8284C21 19.6569 21 17.7712 21 14V12C21 8.22876 21 6.34315 19.8284 5.17157C18.6569 4 16.7712 4 13 4Z\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"></path><path d=\"M3 10H21\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"></path></svg>", "down": "<svg aria-hidden=\"true\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" color=\"currentColor\" data-slot=\"icon\"><path d=\"M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"></path></svg>", "plus": "<svg aria-hidden=\"true\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" color=\"currentColor\"><path d=\"M12.001 5.00003V19.002\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"></path><path d=\"M19.002 12.002L4.99998 12.002\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"></path></svg>", "eye": "<svg aria-hidden=\"true\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" color=\"currentColor\" data-slot=\"icon\"><path d=\"M21.544 11.045C21.848 11.4713 22 11.6845 22 12C22 12.3155 21.848 12.5287 21.544 12.955C20.1779 14.8706 16.6892 19 12 19C7.31078 19 3.8221 14.8706 2.45604 12.955C2.15201 12.5287 2 12.3155 2 12C2 11.6845 2.15201 11.4713 2.45604 11.045C3.8221 9.12944 7.31078 5 12 5C16.6892 5 20.1779 9.12944 21.544 11.045Z\" stroke=\"currentColor\" stroke-width=\"1.5\"></path><path d=\"M15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15C13.6569 15 15 13.6569 15 12Z\" stroke=\"currentColor\" stroke-width=\"1.5\"></path></svg>", "up": "<svg aria-hidden=\"true\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" color=\"currentColor\" data-slot=\"icon\"><path d=\"M17.9998 15C17.9998 15 13.5809 9.00001 11.9998 9C10.4187 8.99999 5.99985 15 5.99985 15\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"></path></svg>", "eval": "<svg aria-hidden=\"true\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" color=\"currentColor\" data-slot=\"icon\"><path d=\"M13.498 2H8.49805C7.66962 2 6.99805 2.67157 6.99805 3.5C6.99805 4.32843 7.66962 5 8.49805 5H13.498C14.3265 5 14.998 4.32843 14.998 3.5C14.998 2.67157 14.3265 2 13.498 2Z\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"></path><path d=\"M6.99805 15H10.4266M6.99805 11H14.998\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"></path><path d=\"M18.9981 13.5V9.48263C18.9981 6.65424 18.9981 5.24004 18.1194 4.36137C17.4781 3.72007 16.5515 3.54681 14.9981 3.5M11.998 21.9995L8.99805 21.9995C6.16963 21.9995 4.75541 21.9995 3.87674 21.1208C2.99806 20.2421 2.99805 18.8279 2.99805 15.9995L2.99806 9.48269C2.99805 6.65425 2.99805 5.24004 3.87673 4.36136C4.51802 3.72007 5.44456 3.54681 6.99795 3.5\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"></path><path d=\"M13.998 20C13.998 20 14.998 20 15.998 22C15.998 22 18.1745 17 20.998 16\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"></path></svg>"};
export const evalIcon = (name: string) => measuredIcons[name] ?? `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name] ?? paths.eval}"/></svg>`;
const button = (text: string, action: string, classes = '', attrs = '') => `<button type="button" class="ne-button ${classes}" data-eval-action="${esc(action)}" ${attrs}>${text}</button>`;
const provenance = () => '<p class="ne-provenance">Synthetic · local demo · no AI evaluator ran</p>';
const header = (title: string, actions: string, icon = 'eval') => `<header class="ne-header"><h1>${evalIcon(icon)}${esc(title)}</h1><div class="ne-header-actions">${actions}</div></header>`;
export type EvalBatchTab = 'Batches' | 'Schedules' | 'Drafts' | 'Assigned to me';
export interface EvalOverviewState {
  tab?: EvalBatchTab;
  filter?: 'all' | 'in-progress' | 'overdue' | 'closed';
  archived?: boolean;
  upcoming?: boolean;
  loading?: boolean;
  error?: string;
  evaluations?: EvaluationDetail[];
}

export function renderEvalOverview(state: EvalOverviewState = {}): string {
  const filter = state.filter ?? 'all', tab = state.tab ?? 'Batches';
  const rows = (state.evaluations ?? []).filter(({evaluation:e}) => filter === 'closed' ? e.state === 'completed' : filter === 'in-progress' ? e.state === 'pending' : filter === 'overdue' ? false : true);
  const tabs = (['Batches','Schedules','Drafts','Assigned to me'] as const).map(x => button(esc(x), `tab:${x}`, x===tab?'ne-active':'', `role="tab" aria-selected="${x===tab}"`)).join('');
  const filters = [['in-progress','In progress'],['overdue','Overdue'],['closed','Closed']].map(([key,label]) => button(esc(label),`filter:${key}`,'ne-pill'+(filter===key?' ne-selected':''),`aria-pressed="${filter===key}"`)).join('');
  const emptyTitle = filter === 'closed' ? 'No closed evals yet' : 'Nothing in progress';
  const emptyText = filter === 'closed' ? 'Evals appear here once they complete or you close them.' : 'Evals currently out for human evaluation will appear here.';
  const empty = `<div class="ne-empty"><div class="ne-empty-icon">${evalIcon('eval')}</div><h2>${emptyTitle}</h2><p>${emptyText}</p></div>`;
  const content = state.loading ? '<div class="ne-empty" role="status"><span class="ne-spinner"></span><p>Loading evaluations…</p></div>' : state.error ? `<div class="ne-empty" role="alert"><h2>Evaluations unavailable</h2><p>${esc(state.error)}</p>${button('Try again','retry')}</div>` : rows.length && tab==='Batches' ? `<div class="ne-table-scroll"><table class="ne-table"><tbody>${rows.map(({evaluation:e,stale})=>`<tr><td>${e.state==='completed'?'Closed':'In progress'}</td><td>${button(esc(e.name),`open:${e.id}`,'ne-text')}${stale?'<small>Saved trace snapshot</small>':''}</td><td>${e.responses.length} / ${e.traceIds.length*e.questions.length}</td><td>One-time</td><td>${esc(e.createdAt.slice(0,10))}</td><td>${[...new Set(e.questions.map(q=>q.reviewer==='buyer'?'You':'Simulated reviewer'))].join(', ')}</td><td>You</td></tr>`).join('')}</tbody></table></div>` : empty;
  return `<section class="ne-evals ne-overview" aria-label="Evaluations">${header('evals',button(evalIcon('badge')+'AI evaluators','evaluators')+button(evalIcon('plus')+'create eval','create','ne-primary')+button(evalIcon('settings'),'view-options','','aria-label="View options"'))}<nav class="ne-tabs" role="tablist">${tabs}</nav><div class="ne-filters">${evalIcon('filter')}${filters}${button('Schedule'+evalIcon('down'),'schedule-filter','ne-pill')}${button('Show upcoming','upcoming','ne-pill',`aria-pressed="${!!state.upcoming}"`)}${button('Show archived','archived','ne-pill',`aria-pressed="${!!state.archived}"`)}${filter!=='all'?button('Clear','filter:all','ne-text'):''}</div><div class="ne-table-scroll"><table class="ne-table"><thead><tr>${['Status','Eval','Progress','Schedule','Eval window','Evaluators','Created by'].map(x=>`<th>${x}</th>`).join('')}</tr></thead></table></div>${content}${provenance()}</section>`;
}

export function renderAiEvaluatorOverview(): string {
  return `<section class="ne-evals ne-ai-overview"><header class="ne-header"><h1>${button(evalIcon('back'),'back-to-evals','ne-text','aria-label="Back to evaluations"')}${evalIcon('badge')}AI evaluators</h1><div class="ne-header-actions"><input type="search" aria-label="Search evaluators" placeholder="Search evaluators…">${button(evalIcon('plus')+'New evaluator','new-evaluator','ne-primary')}</div></header><div class="ne-empty"><div class="ne-empty-icon">${evalIcon('plus')}</div><h2>No evaluators yet</h2><p>Create your first evaluator to score<br>evals with an LLM or agent judge.</p>${button(evalIcon('plus')+'New evaluator','new-evaluator','ne-primary')}</div>${provenance()}</section>`;
}

export type EvalWizardStep = 'type' | 'schedule' | 'conditions' | 'evaluators' | 'form' | 'review';
export interface EvalWizardState {
  step: EvalWizardStep;
  level?: 'trace' | 'span';
  name?: string;
  traceCount?: number;
  recentCount?: number;
  reviewer?: 'buyer' | 'simulated_judge';
  questions?: {label: string; type: string}[];
}
const wizardSteps: EvalWizardStep[] = ['type','schedule','conditions','evaluators','form','review'];
const stepLabel: Record<EvalWizardStep,string> = {type:'Type',schedule:'Schedule',conditions:'Conditions',evaluators:'Evaluators',form:'Form',review:'Review'};
const uncertainty = '<p class="ne-reference-note">Local preview · official screenshot for this step is not yet verified.</p>';
function wizardNavigation(step: EvalWizardStep): string {
  const current = wizardSteps.indexOf(step);
  return `<nav class="ne-step-nav" aria-label="Evaluation setup"><div class="ne-step ${current<3?'ne-current':''}"><span class="ne-step-number">${current<3?'1':'✓'}</span>Dataset</div>${wizardSteps.slice(0,3).map((x,i)=>button(`<span class="ne-dot"></span>${stepLabel[x]}`,`step:${x}`,'ne-substep'+(step===x?' ne-current':''), `aria-current="${step===x?'step':'false'}"`)).join('')}${wizardSteps.slice(3).map((x,i)=>button(`<span class="ne-step-number">${current>i+3?'✓':i+2}</span>${stepLabel[x]}`,`step:${x}`,'ne-step'+(step===x?' ne-current':'')+(current<i+3?' ne-future':''), `aria-current="${step===x?'step':'false'}"`)).join('')}</nav>`;
}
const choice = (title: string, description: string, value: string, selected: boolean, symbol: string) => button(`${symbol}<strong>${esc(title)}</strong><p>${esc(description)}</p>`,`choose:${value}`,'ne-choice'+(selected?' ne-chosen':''),`aria-pressed="${selected}"`);
const lineGraphic = (span: boolean) => `<span class="ne-trace-line ${span?'ne-span-line':''}" aria-hidden="true"><i></i><i></i><i></i></span>`;
function datasetBody(state: EvalWizardState): { title: string; description: string; body: string } {
  const count = state.traceCount ?? 0;
  switch (state.step) {
    case 'type': return {title:'What should one example be?',description:'This sets the input/output pair an evaluator scores — and how many rows your dataset has.',body:`<div class="ne-choice-grid ne-two">${choice('Trace-level','The first message in, the final answer out. One trace, one row.','trace',state.level!=='span',lineGraphic(false))}${choice('Span-level',"One step’s own input and output. One span, one row.",'span',state.level==='span',lineGraphic(true))}</div>`};
    case 'conditions': return {title:'Which traces to evaluate?',description:'These conditions pick the traces to evaluate.',body:`<div class="ne-conditions"><label class="ne-field ne-duration">Duration<small>How far back to search for matches</small><span class="ne-duration-select">${evalIcon('calendar')}<select name="duration" aria-label="Duration"><option>Last 14 days</option><option>Last 7 days</option><option>Last 30 days</option></select></span></label><div class="ne-rule"><span>Where</span><select aria-label="Condition field" name="condition-field"><option>Trace ID</option><option>Name</option></select><select aria-label="Condition operator"><option>is</option></select><input aria-label="Condition value" name="condition-value" placeholder="Trace ID"></div><div class="ne-rule-actions">${button(evalIcon('plus')+'Add rule','add-rule')}${button(evalIcon('down'),'add-rule-options','','aria-label="Rule options"')}</div><p class="ne-sample">${evalIcon('eye')}${button('Preview samples','preview-samples','ne-text')}<span>· ${count} traces in the last 14 days</span></p><label class="ne-field">How many to evaluate<small>Newest matches first from the duration above</small></label><div class="ne-sample-options"><label><input type="radio" name="sampling" value="all">All matching<span>${count} traces</span></label><label><input type="radio" name="sampling" value="recent" checked>Evaluate the most recent<span><span class="ne-number"><input type="number" name="recent-count" aria-label="Recent trace count" min="1" max="${Math.max(1,count)}" value="${state.recentCount??count}"><span class="ne-number-buttons">${button(evalIcon('up'),'recent-increment','','aria-label="Increase recent trace count"')}${button(evalIcon('down'),'recent-decrement','','aria-label="Decrease recent trace count"')}</span></span>traces</span></label></div></div>`};
    case 'schedule': return {title:'When should this eval run?',description:'Choose when to evaluate your saved examples.',body:`${uncertainty}<div class="ne-choice-grid ne-two">${choice('One-time','Evaluate the selected synthetic examples.','once',true,evalIcon('calendar'))}${choice('Recurring','Scheduling is unavailable in this local demo.','recurring',false,evalIcon('calendar'))}</div>`};
    case 'evaluators': return {title:'Who should evaluate?',description:'Choose a reviewer for the evaluation.',body:`${uncertainty}<div class="eval-evaluator-guide ne-choice-grid ne-two">${choice('You','Review each example yourself.','buyer',state.reviewer!=='simulated_judge',evalIcon('eval'))}${choice('Simulated reviewer','Deterministic demo responses. No AI evaluator runs.','simulated_judge',state.reviewer==='simulated_judge',evalIcon('agent'))}</div>`};
    case 'form': return {title:'What should reviewers answer?',description:'Define the questions for each example.',body:`${uncertainty}<div class="eval-criteria-summary">${(state.questions??[{label:'Did the agent meet the user’s requirement?',type:'yes_no'}]).map((q,i)=>`<div class="ne-question"><label class="ne-field">Question ${i+1}<input name="question:${i}" value="${esc(q.label)}" maxlength="120"></label><label class="ne-field">Answer type<select name="question-type:${i}">${['yes_no','rating','choice','text'].map(t=>`<option value="${t}" ${q.type===t?'selected':''}>${t==='yes_no'?'Yes / no':t==='text'?'Free text':t}</option>`).join('')}</select></label></div>`).join('')}${button(evalIcon('plus')+'Add question','add-question')}</div>`};
    case 'review': return {title:'Review your eval',description:'Check the setup before creating the local evaluation.',body:`${uncertainty}<label class="ne-field">Name<input name="evaluation-name" maxlength="100" value="${esc(state.name??'Workflow review')}"></label><dl class="ne-summary"><dt>Dataset</dt><dd>${count} synthetic traces</dd><dt>Evaluator</dt><dd>${state.reviewer==='simulated_judge'?'Simulated reviewer':'You'}</dd><dt>Form</dt><dd>${state.questions?.length??1} questions</dd></dl>${provenance()}`};
  }
}
export function renderEvalWizard(state: EvalWizardState): string {
  const {title,description,body}=datasetBody(state), index=wizardSteps.indexOf(state.step);
  return `<section class="ne-evals ne-wizard ne-step-${state.step} eval-preview-dataset">${header('New eval',button(evalIcon('close'),'cancel','','aria-label="Close new eval"'))}<div class="ne-wizard-layout">${wizardNavigation(state.step)}<div class="ne-step-main"><div class="ne-step-content"><p class="ne-eyebrow">Step ${index<3?'1':index-1} of 4 · ${index<3?'Dataset · ':''}${stepLabel[state.step]}</p><h2>${title}</h2><p class="ne-description">${description}</p>${body}</div><footer class="ne-step-footer">${button(index===0?'Cancel':'Back',index===0?'cancel':'back')}${button(state.step==='review'?'Create evaluation':'Continue',state.step==='review'?'create-local':'continue','ne-primary')}</footer></div></div>${provenance()}</section>`;
}

export type EvaluatorEditorStep = 'type' | 'instructions' | 'model' | 'evidence' | 'try' | 'review';
export interface EvaluatorEditorState {step: EvaluatorEditorStep; kind?: 'agent'|'llm'|'code'; instructions?: string; reasoning?: boolean; customOutput?: boolean; skills?: boolean}
const evaluatorSteps: EvaluatorEditorStep[]=['type','instructions','model','evidence','try','review'];
const evaluatorLabels=['Type','Instructions','Model & output','Evidence','Try it','Review'];
const defaultInstructions=`You are an expert evaluator. Describe the persona and what you are judging (e.g. "You are a meticulous reviewer checking whether the answer is concise and correct").

<Rubric>
Describe how to score a good vs. bad result.
- A strong result: …
- Deduct / fail when: …
</Rubric>

<Instructions>
- Read the input and the agent's output carefully.
- Judge strictly against the rubric above.
- Always explain your reasoning with specific evidence.
</Instructions>

<Reminder>
The goal is a fair, consistent verdict grounded only in the evidence provided.
</Reminder>`;
function toggle(title: string, detail: string, name: string, on: boolean): string {return `<label class="ne-toggle-row"><span>${title}<small>${detail}</small></span><input type="checkbox" role="switch" name="${name}" ${on?'checked':''}></label>`;}
export function renderEvaluatorEditor(state: EvaluatorEditorState): string {
  const index=evaluatorSteps.indexOf(state.step), label=evaluatorLabels[index]!;
  let title=label, description='', body='';
  if(state.step==='type') { title='What kind of evaluator is this?'; description='Choose how this evaluator judges traces and spans.'; body=`<div class="ne-choice-grid ne-three">${choice('Agent judge','Multi-step agent that uses tools to gather evidence.','agent',!state.kind||state.kind==='agent',evalIcon('agent'))}${choice('LLM judge','Single-shot judgment from the model. Fast, no tools.','llm',state.kind==='llm',evalIcon('badge'))}${choice('Code evaluator','Deterministic Python or JavaScript scores.','code',state.kind==='code',evalIcon('code'))}</div>`; }
  else if(state.step==='instructions') {title="Write the evaluator's instructions";description='Define the persona and rubric it follows to judge every trace.';body=`<textarea class="ne-instructions" name="instructions" aria-label="Evaluator instructions">${esc(state.instructions??defaultInstructions)}</textarea>`;}
  else if(state.step==='model') {description='Neatlogs default works for most evaluators.';body=`<div class="ne-model"><label class="ne-field"><span class="ne-uppercase">Model</span><select name="model" aria-label="Model"><option>nl　Neatlogs</option></select></label><p class="ne-uppercase">Output</p>${toggle('Custom output fields','Define the exact questions the evaluator answers for every trace. Off returns a simple verdict.','custom-output',!!state.customOutput)}${toggle('Include reasoning','Ask the evaluator to explain each verdict. Helps debugging and review; adds latency and cost.','reasoning',state.reasoning!==false)}<p class="ne-uppercase">Skills</p>${toggle('Enable skills','Attach SKILL.md capabilities the evaluator can use while judging traces.','skills',!!state.skills)}</div>`;}
  else {description='This step has no verified official screenshot in the collected reference set.';body=`${uncertainty}<p class="ne-local-boundary">${state.step==='try'?'AI execution is unavailable in this local preview. No provider request will be made.':'This unsaved preview does not configure a hosted evaluator.'}</p>`;}
  return `<div class="ne-editor-backdrop"><section class="ne-evals ne-editor" role="dialog" aria-modal="true" aria-label="New evaluator">${header('New evaluator',button(evalIcon('close'),'close-editor','','aria-label="Close evaluator editor"'),'badge')}<div class="ne-editor-layout"><nav class="ne-step-nav" aria-label="Evaluator setup">${evaluatorSteps.map((s,i)=>button(`<span class="ne-step-number">${i<index?'✓':i+1}</span>${evaluatorLabels[i]}`,`editor-step:${s}`,'ne-step'+(i===index?' ne-current':i>index?' ne-future':' ne-complete'),`aria-current="${i===index?'step':'false'}"`)).join('')}</nav><div class="ne-step-main"><div class="ne-step-content"><p class="ne-eyebrow">STEP ${index+1} OF 6 · ${label.toUpperCase()}</p><h2>${title}</h2><p class="ne-description">${description}</p>${body}</div><footer class="ne-step-footer">${index?button('Back','editor-back'):'<span></span>'}${button(index===5?'Close preview':'Continue',index===5?'close-editor':'editor-continue','ne-primary')}</footer></div></div>${provenance()}</section></div>`;
}

/** Event delegation is owned by the host; this decoder confers no permission to mutate. */
export function evalAction(target: EventTarget | null): string | undefined {
  return target instanceof Element ? target.closest<HTMLElement>('[data-eval-action]')?.dataset.evalAction : undefined;
}
