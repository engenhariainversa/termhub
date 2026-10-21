import { chatsOrder, tabsNeedingYou } from './project-list';

describe('chatsOrder', () => {
  it('puts the Favoritos first, in their order, then the rest in the order received', () => {
    const projects = [
      { id: 'a', favorite_position: null },
      { id: 'b', favorite_position: 1 },
      { id: 'c', favorite_position: null },
      { id: 'd', favorite_position: 0 },
      { id: 'e' },
    ];
    expect(chatsOrder(projects).map((p) => p.id)).toEqual(['d', 'b', 'a', 'c', 'e']);
  });

  it('keeps the received order when nothing is pinned', () => {
    expect(chatsOrder([{ id: 'x', favorite_position: null }, { id: 'y', favorite_position: null }]).map((p) => p.id)).toEqual(['x', 'y']);
  });
});

describe('tabsNeedingYou', () => {
  it('counts the tabs waiting on the person, per project', () => {
    const counts = tabsNeedingYou([
      { project: { id: 'p1' }, needs_you: true },
      { project: { id: 'p1' }, needs_you: false },
      { project: { id: 'p1' }, needs_you: true },
      { project: { id: 'p2' }, needs_you: false },
    ]);
    expect(counts.get('p1')).toBe(2);
    expect(counts.has('p2')).toBe(false);
  });
});
