export const SUBMISSION_POLICY = Object.freeze({
  submitSource:
    '^(?:submit|send|apply|enviar|finalizar|concluir|candidatar|postular|aplicar|bewerben|confirmar|finali[sz]e|finish)\\b|(?:submit|send|complete|confirm|finali[sz]e|finish) application\\b|enviar candidatura|finalizar candidatura',
  uploadSource:
    '\\b(?:attach|upload|anexar|carregar|choose file|browse)\\b|^(?:send|enviar)\\b.*\\b(?:resume|résumé|cv|curr[ií]culo|file|arquivo|documento)\\b',
});

export function isSubmitLikeText(text) {
  return new RegExp(SUBMISSION_POLICY.submitSource, 'i').test(String(text ?? '').replace(/\s+/g, ' ').trim());
}

export function isUploadLikeText(text) {
  return new RegExp(SUBMISSION_POLICY.uploadSource, 'i').test(String(text ?? '').replace(/\s+/g, ' ').trim());
}
