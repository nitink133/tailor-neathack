import type { EvaluationCheck, EvaluationCheckResult, EvaluationQuestion, EvaluationResponse } from './eval-contract.ts';
import type { Trace } from './contracts.ts';

/** Executes fixed predicates over the immutable snapshot. No model, network or buyer-supplied code runs. */
export function executeChecks(traces: Trace[], checks: EvaluationCheck[]): EvaluationCheckResult[] {
  return traces.flatMap(trace => checks.map(check => {
    const base = { traceId:trace.id, checkKey:check.key, source:'deterministic_check' as const, provenance:'local_trace_snapshot' as const };
    let passed: boolean | null;
    let observed: EvaluationCheckResult['observed'];
    let evidenceSpanIds: string[];
    let explanation: string;
    if (check.kind === 'no_error') {
      const errors = trace.spans.filter(s => s.status === 'ERROR' || s.error !== null);
      passed = trace.spans.length ? errors.length === 0 : null;
      observed = {errorSpanIds:errors.map(s => s.id)};
      evidenceSpanIds = trace.spans.map(s => s.id);
      explanation = passed === null ? 'No spans available to check.' : `${errors.length} of ${trace.spans.length} snapshot spans have an error. This checks execution, not answer quality.`;
    } else if (check.kind === 'latency') {
      const spans = trace.spans;
      const valid = spans.length > 0 && spans.every(s => Number.isFinite(s.startMs) && Number.isFinite(s.durationMs) && s.durationMs >= 0);
      const elapsedMs = valid ? Math.max(...spans.map(s => s.startMs + s.durationMs)) - Math.min(...spans.map(s => s.startMs)) : null;
      passed = elapsedMs === null ? null : elapsedMs <= check.maxDurationMs;
      observed = elapsedMs === null ? {} : {elapsedMs};
      evidenceSpanIds = spans.map(s => s.id);
      explanation = elapsedMs === null ? 'Snapshot timing is unavailable.' : `Snapshot elapsed time is ${elapsedMs} ms; threshold is at most ${check.maxDurationMs} ms. This is synthetic trace timing, not a live benchmark.`;
    } else {
      const output = trace.output;
      const record = output !== null && typeof output === 'object' && !Array.isArray(output) ? output : null;
      const missingFields = check.fields.filter(field => !record || !Object.hasOwn(record,field) || record[field] === null || record[field] === '');
      passed = missingFields.length === 0;
      observed = {missingFields};
      evidenceSpanIds = trace.spans.filter(s => s.parentId === null).map(s => s.id);
      explanation = missingFields.length ? `Missing or empty top-level output fields: ${missingFields.join(', ')}.` : 'All required top-level output fields are present and non-empty. Field correctness still needs review.';
    }
    return {...base,passed,status:passed === null ? 'unavailable' as const : passed ? 'passed' as const : 'failed' as const,observed,evidenceSpanIds,explanation};
  }));
}

/** A mixed review form; "simulated_judge" is deterministic demo data, never an LLM judge. */
export function syntheticReviewQuestions(): EvaluationQuestion[] {
  return [
    { key: 'resolved', label: 'Did the output resolve the fictional request?', type: 'yes_no', required: true, reviewer: 'simulated_judge' },
    { key: 'quality', label: 'How useful and accurate is the answer?', type: 'rating', min: 1, max: 5, required: true, reviewer: 'buyer' },
    { key: 'notes', label: 'What should change?', type: 'text', required: false, reviewer: 'buyer' },
  ];
}

/** Deterministic placeholder verdicts. The caller must retain simulated provenance in every result. */
export function simulatedResponses(traces: Trace[], questions: EvaluationQuestion[]): EvaluationResponse[] {
  return traces.flatMap(trace => questions.filter(q => q.reviewer === 'simulated_judge').map(q => {
    const successful = trace.outcomeKind === 'success';
    const value = q.type === 'yes_no' ? successful
      : q.type === 'rating' ? (successful ? q.max! : q.min!)
      : q.type === 'choice' ? q.options![successful ? 0 : q.options!.length - 1]!
      : `Simulated review: ${trace.label}; fictional outcome ${trace.outcome}. No AI evaluator ran.`;
    return { traceId: trace.id, questionKey: q.key, value, source: 'simulated_judge' as const,
      evidenceSpanIds: trace.spans.filter(s => s.parentId === null || s.status === 'ERROR').map(s => s.id) };
  }));
}

import { CONTRACT_VERSION, type ScenarioProposal, type ProposedSpan } from './agent-contract.ts';

export type QualityWorkflow = 'retrieval' | 'extraction' | 'support';
/** Substantive quality examples: valid execution may still return an unhelpful or unsupported answer. */
export function qualityWorkflowProposal(workflow: QualityWorkflow, expectedVersion: number): ScenarioProposal {
  const examples = {
    retrieval: {
      domain: 'documentation question-answering agent', label: 'Unsupported documentation answer', outcome: 'unsupported_answer',
      input: { synthetic:true, question:'Does the fictional Widget SDK support offline sync?' },
      source: { document:'SYNTHETIC Widget quickstart', text:'The Widget SDK sends updates while connected. Offline behavior is not documented.' },
      output: { synthetic:true, answer:'Offline sync is supported automatically.', citations:['SYNTHETIC Widget quickstart'] },
      step:'retrieve_widget_docs', kind:'RETRIEVAL' as const,
      summary:'The retriever returns a relevant document, but the generated answer asserts a feature absent from that source.',
    },
    extraction: {
      domain:'invoice extraction agent', label:'Incomplete invoice extraction', outcome:'missing_required_field',
      input:{ synthetic:true, document:'SYNTHETIC invoice: total 42 USD; due 2026-11-01; invoice SYN-INV-42.' },
      source:{ invoiceId:'SYN-INV-42', total:42, currency:'USD', dueDate:'2026-11-01' },
      output:{ synthetic:true, invoiceId:'SYN-INV-42', total:42, currency:'USD', dueDate:null },
      step:'extract_invoice_fields', kind:'LLM' as const,
      summary:'The extractor returns valid structured output but omits the due date present in the source.',
    },
    support: {
      domain:'customer support agent', label:'Polite answer without resolution', outcome:'request_unresolved',
      input:{ synthetic:true, request:'My fictional parcel SYN-PARCEL-42 is late. What can I do next?' },
      source:{ parcelId:'SYN-PARCEL-42', status:'delayed', nextStep:'Contact the fictional carrier using reference SYN-42.' },
      output:{ synthetic:true, answer:'Thanks for your patience. We appreciate you!', resolved:false },
      step:'lookup_parcel_status', kind:'TOOL' as const,
      summary:'A successful lookup contains an actionable next step, but the final response gives polite filler and does not resolve the request.',
    },
  };
  const e = examples[workflow];
  const spans: ProposedSpan[] = [
    { key:'root',parentKey:null,name:`SYNTHETIC ${workflow} quality review`,kind:'WORKFLOW',startMs:0,durationMs:100,status:'OK',input:e.input,output:e.output,error:null,detection:false },
    { key:'source',parentKey:'root',name:e.step,kind:e.kind,startMs:5,durationMs:40,status:'OK',input:e.input,output:e.source,error:null,detection:false },
    { key:'answer',parentKey:'root',name:'prepare_answer',kind:'LLM',startMs:50,durationMs:45,status:'OK',input:e.source,output:e.output,error:null,detection:false },
  ];
  return { kind:'scenario_proposal',contractVersion:CONTRACT_VERSION,expectedVersion,mode:'new',
    story:{domain:e.domain,summary:e.summary,assumptions:['All content is fictional; the example demonstrates answer quality rather than a thrown execution error.']},
    activeScenario:`${workflow}-quality`,traces:[{key:`${workflow}-quality`,label:e.label,name:`SYNTHETIC ${e.domain}`,outcome:e.outcome,outcomeKind:'degraded',tags:['synthetic','quality',workflow],input:e.input,output:e.output,spans}] };
}
