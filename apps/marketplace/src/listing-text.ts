export const EXCERPT_MAX_CHARACTERS = 255;
export const DESCRIPTION_MAX_CHARACTERS = 5000;

// Match the protocol's Text.size(): supplementary Unicode characters count once.
export function listingCharacterCount(text: string): number { return Array.from(text).length; }

export function validateListingText(input: { summary: string; description: string }): void {
  if (listingCharacterCount(input.summary) > EXCERPT_MAX_CHARACTERS) throw new Error(`Keep the excerpt to ${EXCERPT_MAX_CHARACTERS} characters or fewer.`);
  if (listingCharacterCount(input.description) > DESCRIPTION_MAX_CHARACTERS) throw new Error(`Keep the description to ${DESCRIPTION_MAX_CHARACTERS.toLocaleString("en-US")} characters or fewer.`);
}
