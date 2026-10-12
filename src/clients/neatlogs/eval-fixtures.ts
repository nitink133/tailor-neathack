import type { EvaluationQuestion, EvaluationResponse } from './eval-contract.ts';
import type { Trace } from './contracts.ts';

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
