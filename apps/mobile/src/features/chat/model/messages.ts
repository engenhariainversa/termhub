// Every line the chat feature's store shows a person (pt-BR, the product language). The sentences
// under a stopped answer and the host line live in `copy.ts`, verbatim from the web.
export const CHAT_MSG = {
  busy: 'O chat ainda está respondendo. Aguarde.',
  alreadyDecided: 'Essa ação já foi decidida.',
  notFound: 'Conversa não encontrada.',
  updateApp: 'Atualize o app para continuar.',
  network: 'Não foi possível falar com o servidor. Tente de novo.',
  tabPromptChanged: 'A pergunta mudou na aba',
  tabSuggestionChanged: 'A sugestão mudou na aba',
  attachmentType: 'Tipo de arquivo não suportado',
  attachmentLegacyOffice: 'Envie como .docx/.xlsx',
  attachmentTooLarge: 'Arquivo acima de',
  attachmentTooMany: 'No máximo 5 anexos por mensagem',
  attachmentUploadFailed: 'Não foi possível enviar o arquivo',
  attachmentUploading: 'enviando anexo…',
  attachmentGalleryDenied: 'Permissão da galeria negada',
} as const;
