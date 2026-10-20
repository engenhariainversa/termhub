import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, Share, Text } from 'react-native';
import { chatMarkdownIt, chatMarkdownRules } from './chat-links';
import { LinkedText } from './linked-text';
import { markdownStyle } from './markdown-style';

/** The hrefs markdown-it gives an answer, in order. */
const hrefs = (md: string) => [...chatMarkdownIt.render(md).matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));

// The real renderer: test/ui-setup.js swaps the package for a plain `Text`.
const Markdown = jest.requireActual('react-native-markdown-display').default as typeof import('react-native-markdown-display').default;

const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
beforeEach(() => {
  openURL.mockClear();
  share.mockClear();
});

// TER-1089: bare URLs in an answer are links.
describe('chatMarkdownIt', () => {
  it('links a bare URL with an IP and port, without the final full stop', () => {
    expect(hrefs('A imagem: http://192.168.68.114:8765/termhub-linkedin-final.png.')).toEqual(['http://192.168.68.114:8765/termhub-linkedin-final.png']);
  });

  it('keeps a long query string and a fragment, and leaves out the parenthesis around the URL', () => {
    expect(hrefs('(login: https://claude.com/cai/oauth/authorize?code=true&state=a_b#x)')).toEqual(['https://claude.com/cai/oauth/authorize?code=true&state=a_b#x']);
  });

  it('keeps Markdown links, and links URLs in lists and tables', () => {
    expect(hrefs('[login](https://claude.com/x)\n\n- https://a.dev/1\n\n| x |\n|---|\n| https://a.dev/2 |')).toEqual(['https://claude.com/x', 'https://a.dev/1', 'https://a.dev/2']);
  });

  it('links nothing but http(s), and nothing in code', () => {
    expect(hrefs('termhub.dev www.termhub.dev a@b.dev ftp://x.dev //x.dev mailto:a@b.dev')).toEqual([]);
    expect(hrefs('`https://a.dev/1`\n\n```\ncurl https://a.dev/2\n```')).toEqual([]);
  });
});

describe('chatMarkdownRules', () => {
  const show = (text: string, onLinkPress?: (url: string) => boolean) =>
    render(
      <Markdown style={markdownStyle('dark')} rules={chatMarkdownRules} markdownit={chatMarkdownIt} onLinkPress={onLinkPress}>
        {text}
      </Markdown>,
    );

  it('opens a bare URL in the browser on a tap, and shares it on a long press', async () => {
    await show('Abra https://termhub.dev/x.');
    const link = screen.getByText('https://termhub.dev/x');
    await fireEvent.press(link);
    expect(openURL).toHaveBeenCalledWith('https://termhub.dev/x');
    await fireEvent(link, 'longPress');
    expect(share).toHaveBeenCalledWith({ message: 'https://termhub.dev/x' });
  });

  it('lets onLinkPress keep a link in the app', async () => {
    const onLinkPress = jest.fn(() => false);
    await show('[a.md](termhub-file:a.md)', onLinkPress);
    await fireEvent.press(screen.getByText('a.md'));
    expect(onLinkPress).toHaveBeenCalledWith('termhub-file:a.md');
    expect(openURL).not.toHaveBeenCalled();
  });

  it('never opens another scheme', async () => {
    await show('[mail](mailto:a@b.dev)');
    await fireEvent.press(screen.getByText('mail'));
    expect(openURL).not.toHaveBeenCalled();
  });
});

describe('LinkedText', () => {
  it("links the URLs of the person's text and keeps the rest as typed", async () => {
    await render(
      <Text>
        <LinkedText text="abre http://192.168.68.114:8765/a.png. e **isto**" />
      </Text>,
    );
    expect(screen.getByText(/e \*\*isto\*\*/)).toBeTruthy();
    const link = screen.getByText('http://192.168.68.114:8765/a.png');
    await fireEvent.press(link);
    expect(openURL).toHaveBeenCalledWith('http://192.168.68.114:8765/a.png');
    await fireEvent(link, 'longPress');
    expect(share).toHaveBeenCalledWith({ message: 'http://192.168.68.114:8765/a.png' });
  });
});
