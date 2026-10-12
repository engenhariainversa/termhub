/** Headers of a POST to docker/whisper: the clip's type and, when there is one, the shared secret. */
export function whisperHeaders(mime: string, secret: string | null | undefined): Record<string, string> {
  return secret ? { 'content-type': mime, authorization: `Bearer ${secret}` } : { 'content-type': mime };
}
