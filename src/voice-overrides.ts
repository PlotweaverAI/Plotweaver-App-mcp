/**
 * Hand-maintained voice metadata. Everything else about a voice (which endpoint it lives on,
 * its gender, its language) comes from the STORM servers' /voices and /speakers responses,
 * so a new voice on a server works without any change here.
 *
 * Edit this file only to:
 * - add a friendly alias for a speaker the server lists under an internal ID
 * - give a speaker a display label
 */
export const VOICE_OVERRIDES = {
  /** Lowercase alias -> canonical speaker name or internal ID as the server lists it. */
  aliases: {
    john: 'slr70_ngm_09334',
    slr70_ngm_09334: 'slr70_ngm_09334',
  } as Record<string, string>,

  /** Canonical speaker name -> display label shown to users. */
  labels: {
    slr70_ngm_09334: 'John',
  } as Record<string, string>,
};
