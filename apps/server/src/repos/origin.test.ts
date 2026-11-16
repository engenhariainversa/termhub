import { describe, expect, it } from 'vitest';
import { repoOfOrigin } from './origin.js';

describe('repoOfOrigin', () => {
  it.each([
    ['https://github.com/acme/web.git', 'acme/web'],
    ['https://github.com/acme/web', 'acme/web'],
    ['https://github.com/acme/web/', 'acme/web'],
    ['https://x-access-token:abc@github.com/acme/web.git', 'acme/web'],
    ['git@github.com:acme/web.git', 'acme/web'],
    ['ssh://git@github.com/acme/web.git', 'acme/web'],
    ['ssh://git@ssh.github.com:443/acme/web.git', 'acme/web'],
    ['git@github.com-work:acme/hub-community-bff.git', 'acme/hub-community-bff'],
    ['git@github-work:acme/web.git', 'acme/web'],
    ['https://GitHub.com/Acme/Web.git', 'Acme/Web'],
  ])('reads %s as the GitHub repository %s', (url, full_name) => {
    expect(repoOfOrigin(url)).toEqual({ full_name, github: true });
  });

  it('names any other host with the host, so it never matches a GitHub repository of the same name', () => {
    expect(repoOfOrigin('git@gitlab.com:acme/group/web.git')).toEqual({ full_name: 'gitlab.com/acme/group/web', github: false });
    expect(repoOfOrigin('https://bitbucket.org/acme/web')).toEqual({ full_name: 'bitbucket.org/acme/web', github: false });
    expect(repoOfOrigin('https://user:secret@git.example.com/acme/web.git')).toEqual({ full_name: 'git.example.com/acme/web', github: false });
  });

  it('answers null for no origin, a local path or a malformed URL', () => {
    for (const url of [null, undefined, '', '   ', '/srv/git/web.git', '../web', 'https://github.com/', 'https://github.com/a/b/c', 'https://github.com/a/..']) {
      expect(repoOfOrigin(url)).toBeNull();
    }
  });
});
