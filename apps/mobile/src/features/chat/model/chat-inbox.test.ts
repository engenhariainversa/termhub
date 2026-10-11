import { onChatFiles, queueChatFile, takeChatFiles } from './chat-inbox';

const file = (name: string) => ({ uri: `file:///c/${name}`, name, mime: 'text/markdown', bytes: 3 });

describe('chat inbox', () => {
  it('keeps files per chat until that chat takes them, and says when some arrive', () => {
    const heard: string[] = [];
    const off = onChatFiles((k) => heard.push(k));
    queueChatFile('p1', file('a.md'));
    queueChatFile(null, file('b.md'));
    expect(heard).toEqual(['p1', '']);
    expect(takeChatFiles('p1').map((f) => f.name)).toEqual(['a.md']);
    expect(takeChatFiles('p1')).toEqual([]);
    expect(takeChatFiles('').map((f) => f.name)).toEqual(['b.md']);
    off();
  });
});
