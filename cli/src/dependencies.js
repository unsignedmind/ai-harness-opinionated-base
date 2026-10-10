// Step dependencies of a plan: "depends-on" per step, "dependencies-checked" per plan.
//
// A plan whose "dependencies-checked" is true carries "depends-on" on every step: a list of step refs this step
// needs done first. A ref is "<step slug>" (same phase) or "<phase slug>/<step slug>" (an earlier phase, never a
// later one). [] = independent. Without a cross-phase ref a step implicitly waits for every earlier phase to be
// done (the phase barrier); a cross-phase ref relaxes that barrier for this step only.
// "dependencies-checked" false or missing (an older plan, or a plan ability that never ran the dependency pass):
// "depends-on" is ignored, the steps run in array order, as before.

export const DEPS_FIELD = 'depends-on';
export const DEPS_CHECKED = 'dependencies-checked';

const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

export const dependenciesChecked = (plan) => plan?.[DEPS_CHECKED] === true;

// "<phase>/<step>" -> { phaseSlug, stepSlug }; "<step>" -> { phaseSlug: null, stepSlug }
export function parseRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error(`Invalid dependency ref ${JSON.stringify(ref)}`);
  const parts = ref.split('/');
  if (parts.length > 2 || parts.some((p) => !p)) throw new Error(`Invalid dependency ref "${ref}": use <step slug> or <phase slug>/<step slug>`);
  return parts.length === 2 ? { phaseSlug: parts[0], stepSlug: parts[1] } : { phaseSlug: null, stepSlug: parts[0] };
}

// Resolves every "depends-on" of a plan with "dependencies-checked" true. Throws on: a step without the field, a
// ref to a missing step, a later phase or itself, duplicate step slugs in a phase, a cycle inside a phase.
// Returns [{ phaseIndex, stepIndex, phase, step, deps: [{ phaseIndex, stepIndex, crossPhase }] }].
export function resolveDependencies(phases) {
  const phaseIndex = new Map();
  phases.forEach((phase, i) => phaseIndex.set(phase.slug, i));
  const stepIndex = phases.map((phase) => {
    const seen = new Map();
    list(phase.steps).forEach((step, j) => {
      if (seen.has(step.slug)) {
        throw new Error(`Step slug "${step.slug}" is used twice in phase "${phase.slug}": depends-on refs must be unambiguous`);
      }
      seen.set(step.slug, j);
    });
    return seen;
  });

  const resolved = [];
  phases.forEach((phase, pi) => {
    list(phase.steps).forEach((step, si) => {
      const where = `step "${step.slug}" in phase "${phase.slug}"`;
      const refs = step[DEPS_FIELD];
      if (!Array.isArray(refs)) {
        throw new Error(`${where} has no "depends-on" list (dependencies-checked is true: every step needs one, [] = independent)`);
      }
      const deps = refs.map((ref) => {
        const { phaseSlug, stepSlug } = parseRef(ref);
        const targetPhase = phaseSlug === null ? pi : phaseIndex.get(phaseSlug);
        if (targetPhase === undefined) throw new Error(`${where} depends on "${ref}": no phase "${phaseSlug}"`);
        if (targetPhase > pi) throw new Error(`${where} depends on "${ref}": a later phase, only earlier phases are allowed`);
        if (phaseSlug !== null && targetPhase === pi) throw new Error(`${where} depends on "${ref}": its own phase, use "${stepSlug}"`);
        const targetStep = stepIndex[targetPhase].get(stepSlug);
        if (targetStep === undefined) throw new Error(`${where} depends on "${ref}": no step "${stepSlug}" in phase "${phases[targetPhase].slug}"`);
        if (targetPhase === pi && targetStep === si) throw new Error(`${where} depends on itself`);
        return { phaseIndex: targetPhase, stepIndex: targetStep, crossPhase: targetPhase !== pi };
      });
      resolved.push({ phaseIndex: pi, stepIndex: si, phase, step, deps });
    });
  });

  // cycles are only possible inside a phase (cross-phase refs point backwards): Kahn per phase
  phases.forEach((phase, pi) => {
    const steps = list(phase.steps);
    const indegree = steps.map(() => 0);
    const out = steps.map(() => []);
    for (const entry of resolved.filter((e) => e.phaseIndex === pi)) {
      for (const dep of entry.deps.filter((d) => !d.crossPhase)) {
        out[dep.stepIndex].push(entry.stepIndex);
        indegree[entry.stepIndex]++;
      }
    }
    const queue = indegree.map((n, j) => (n === 0 ? j : -1)).filter((j) => j >= 0);
    let visited = 0;
    while (queue.length) {
      const j = queue.shift();
      visited++;
      for (const k of out[j]) if (--indegree[k] === 0) queue.push(k);
    }
    if (visited !== steps.length) {
      const stuck = steps.filter((_, j) => indegree[j] > 0).map((s) => s.slug);
      throw new Error(`Dependency cycle in phase "${phase.slug}" between steps: ${stuck.join(', ')}`);
    }
  });
  return resolved;
}

// Validation entry used by validatePlan: phase slugs unique always; dependencies only when the flag is true.
export function validateDependencies(plan, phases) {
  const slugs = new Set();
  for (const phase of phases) {
    if (slugs.has(phase.slug)) throw new Error(`Phase slug "${phase.slug}" is used twice in the plan`);
    slugs.add(phase.slug);
  }
  if (dependenciesChecked(plan)) resolveDependencies(phases);
}
