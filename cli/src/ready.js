import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dependenciesChecked, resolveDependencies } from './dependencies.js';
import { asList, resolveDomain, PLAN_FILE } from './plan.js';
import { parallelConfig } from './project-config.js';
import { specFileOf } from './roots.js';

// nos ready: which steps of a plan may start now. The orchestrator schedules from this answer only.
//   specify:   open steps whose dependencies are done (and the phase barrier holds, see dependencies.js)
//   develop:   specified steps whose dependencies are done
//   running:   an ability works on them (in-specification, in-progress, in-review)
//   continue:  between abilities, the orchestrator's own transition is next (implemented, reviewed)
//   blocked:   open or specified steps waiting: waitsOn (step ids), waitsOnPhases (phase ids, the barrier)
//   phasesReviewable: phases whose steps are all done and whose review has not started
//   phasesContinuing: phases mid-review (implemented, in-review, reviewed)
// "dependencies-checked" false → mode "sequential": the first unfinished step in array order is the only one
// listed (as today), every later one is blocked on it.

const STEP_DONE = ['done', 'merged', 'discarded'];
const STEP_RUNNING = ['in-specification', 'in-progress', 'in-review'];
const STEP_CONTINUE = ['implemented', 'reviewed'];
const PHASE_DONE = ['done'];
const PHASE_CONTINUE = ['implemented', 'in-review', 'reviewed'];

const idsOf = (step) => {
  let file;
  try {
    file = specFileOf(step);
  } catch {
    return {};
  }
  const match = file.match(/\/phase-(\d+)-[^/]+\/step-(\d+)-[^/]+\.md$/);
  return match ? { phase: Number(match[1]), step: Number(match[2]) } : {};
};

const entryOf = (phase, step, extra = {}) => ({
  id: idsOf(step).step ?? null,
  slug: step.slug,
  phase: idsOf(step).phase ?? null,
  phaseSlug: phase.slug,
  status: step.status,
  ...extra,
});

const phaseEntry = (phase) => ({
  id: asList(phase.steps).map((s) => idsOf(s).phase).find(Boolean) ?? null,
  slug: phase.slug,
  status: phase.status,
});

const stepDone = (step) => STEP_DONE.includes(step.status);
// a phase is done by its status only: its review is the barrier, not its last step
const phaseDone = (phase) => PHASE_DONE.includes(phase.status);

function emptyResult() {
  return { specify: [], develop: [], running: [], continue: [], blocked: [], phasesReviewable: [], phasesContinuing: [] };
}

function classifyStep(result, phase, step, { depsOk, barrierOk, waitsOn, waitsOnPhases }) {
  const { status } = step;
  if (stepDone(step)) return;
  if (STEP_RUNNING.includes(status)) return result.running.push(entryOf(phase, step));
  if (STEP_CONTINUE.includes(status)) return result.continue.push(entryOf(phase, step));
  if (status === 'open' && depsOk && barrierOk) return result.specify.push(entryOf(phase, step));
  if (status === 'specified' && depsOk) return result.develop.push(entryOf(phase, step));
  result.blocked.push(entryOf(phase, step, { waitsOn, waitsOnPhases }));
}

function classifyPhase(result, phase) {
  if (PHASE_DONE.includes(phase.status)) return;
  if (PHASE_CONTINUE.includes(phase.status)) return result.phasesContinuing.push(phaseEntry(phase));
  const steps = asList(phase.steps);
  if (steps.length && steps.every(stepDone)) result.phasesReviewable.push(phaseEntry(phase));
}

function readyByDependencies(phases) {
  const result = emptyResult();
  const resolved = resolveDependencies(phases);
  for (const { phaseIndex, phase, step, deps } of resolved) {
    const open = deps.filter((d) => !stepDone(asList(phases[d.phaseIndex].steps)[d.stepIndex]));
    const crossPhase = deps.some((d) => d.crossPhase);
    // the barrier gates only open steps: a step started before a fix phase was inserted in front continues
    const earlier = phases.slice(0, phaseIndex).filter((p) => !phaseDone(p));
    const barrierOk = crossPhase || step.status !== 'open' || earlier.length === 0;
    classifyStep(result, phase, step, {
      depsOk: open.length === 0,
      barrierOk,
      waitsOn: open.map((d) => idsOf(asList(phases[d.phaseIndex].steps)[d.stepIndex]).step ?? null),
      waitsOnPhases: crossPhase || step.status !== 'open' ? [] : earlier.map((p) => phaseEntry(p).id),
    });
  }
  phases.forEach((phase) => classifyPhase(result, phase));
  return result;
}

function readySequential(phases) {
  const result = emptyResult();
  let previous = null;
  for (const phase of phases) {
    for (const step of asList(phase.steps)) {
      if (stepDone(step)) continue;
      if (previous === null) classifyStep(result, phase, step, { depsOk: true, barrierOk: true, waitsOn: [], waitsOnPhases: [] });
      else result.blocked.push(entryOf(phase, step, { waitsOn: [previous], waitsOnPhases: [] }));
      previous = idsOf(step).step ?? null;
    }
  }
  phases.forEach((phase) => classifyPhase(result, phase));
  return result;
}

// Pure: the ready sets of a plan object.
export function computeReady(plan) {
  const phases = asList(plan?.phases);
  const checked = dependenciesChecked(plan);
  const sets = checked ? readyByDependencies(phases) : readySequential(phases);
  const done = phases.length > 0 && phases.every(phaseDone);
  return { dependenciesChecked: checked, mode: checked ? 'dependencies' : 'sequential', done, ...sets };
}

export function planReady(roots, { domain } = {}) {
  const domainDir = resolveDomain(roots, domain, 'ready');
  const planPath = path.join(domainDir, PLAN_FILE);
  if (!existsSync(planPath)) throw new Error(`Domain ${domain} has no plan.json. Run create-plan first`);
  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${planPath}: ${err.message}`);
  }
  return { domain, planPath, parallel: parallelConfig(roots), ...computeReady(plan) };
}
