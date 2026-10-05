// Hash routes: #domains[/idea[/phase[/step]]] (quick steps: #domains/idea/quick-steps[/step]),
// #ideas[/idea[/quick-steps[/step]]] for domains without a plan, #board?<filters>, #backlog?<filters>, #docs[/path/in/docs].
import { DEFAULT_FILTERS, parseQuery, toQuery, type Filters } from './filter';
import { isMatured, type Idea, type Phase, type Step } from './model';

export type View = 'ideas' | 'domains' | 'board' | 'backlog' | 'docs';

export type Route = {
  view: View;
  idea?: string;
  phase?: string;
  step?: string;
  // docs: path inside the docs folder
  doc?: string;
  filters: Filters;
};

const VIEWS: readonly View[] = ['ideas', 'domains', 'board', 'backlog', 'docs'];

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const qi = raw.indexOf('?');
  const path = qi < 0 ? raw : raw.slice(0, qi);
  const query = qi < 0 ? '' : raw.slice(qi + 1);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  // #explore is the old name of #domains, kept so old links still work
  if (parts[0] === 'explore') parts[0] = 'domains';
  const view = VIEWS.includes(parts[0] as View) ? (parts[0] as View) : 'domains';
  if (view === 'docs') {
    const doc = parts.slice(1).join('/');
    return doc ? { view, doc, filters: DEFAULT_FILTERS } : { view, filters: DEFAULT_FILTERS };
  }
  if (view !== 'domains' && view !== 'ideas') return { view, filters: parseQuery(query) };
  if (parts[0] !== view) return { view, filters: DEFAULT_FILTERS };
  const r: Route = { view, filters: DEFAULT_FILTERS };
  if (parts[1]) r.idea = parts[1];
  if (parts[2]) r.phase = parts[2];
  if (parts[3]) r.step = parts[3];
  return r;
}

const seg = encodeURIComponent;

// Route segment in place of the phase slug for the quick steps of an idea
export const QUICK_SEGMENT = 'quick-steps';

// page an idea lives on: domains once it has a plan, ideas before
export const viewOf = (idea: Idea): View => (isMatured(idea) ? 'domains' : 'ideas');

const base = (idea: Idea) => `#${viewOf(idea)}/${seg(idea.slug)}`;

export const hrefOfQuick = (idea: Idea) => `${base(idea)}/${QUICK_SEGMENT}`;

export function hrefOf(x: Idea | Phase | Step): string {
  if (x.kind === 'idea') return base(x);
  if (x.kind === 'phase') return `${base(x.idea)}/${seg(x.slug)}`;
  const group = x.phase ? seg(x.phase.slug) : QUICK_SEGMENT;
  return `${base(x.idea)}/${group}/${seg(x.slug)}`;
}

export const hrefOfDoc = (path: string) => '#docs' + (path ? '/' + path.split('/').map(seg).join('/') : '');

export function viewHref(view: View, filters: Filters = DEFAULT_FILTERS): string {
  const q = toQuery(filters);
  return `#${view}${q ? '?' + q : ''}`;
}
