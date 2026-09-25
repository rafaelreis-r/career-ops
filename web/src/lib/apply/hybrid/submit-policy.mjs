export const SUBMISSION_POLICY = Object.freeze({
  submitSource:
    '^(?:submit|send|apply|enviar|finalizar|concluir|candidatar|postular|aplicar|bewerben|confirmar|finali[sz]e|finish)\\b|(?:submit|send|complete|confirm|finali[sz]e|finish) application\\b|enviar candidatura|finalizar candidatura',
  uploadSource:
    '\\b(?:attach|upload|anexar|carregar|choose file|browse)\\b|^(?:send|enviar)\\b.*\\b(?:resume|résumé|cv|curr[ií]culo|file|arquivo|documento)\\b',
});

// A link's href/formaction that opens the application form — never a final
// submit, since a link can't POST a form. Gupy's "/candidates/<job>/apply",
// Get on Board's "/applications/new", and the "/job-apply/" pattern other ATS
// platforms use. The trigger finder in adapters.mjs checks this before an
// anchor's text, since "Candidatar-se"/"Apply now" both match submitSource
// above.
export const ENTRY_LINK_POLICY = Object.freeze({
  destinationSource: '/(?:apply|job-apply|candidat|applications?/new)',
});

export function isSubmitLikeText(text) {
  return new RegExp(SUBMISSION_POLICY.submitSource, 'i').test(String(text ?? '').replace(/\s+/g, ' ').trim());
}

export function isUploadLikeText(text) {
  return new RegExp(SUBMISSION_POLICY.uploadSource, 'i').test(String(text ?? '').replace(/\s+/g, ' ').trim());
}
