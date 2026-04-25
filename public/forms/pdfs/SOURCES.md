# PDF sources

These are blank, fillable AcroForm PDFs of the ACORD forms we support. ACORD
does not host blanks publicly; agencies and wholesalers redistribute them.

| File             | Form                                          | Source URL                                                                                                                                                       | Retrieved   |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `acord-125.pdf`  | ACORD 125 — Commercial Insurance Application  | https://easternunderwritingmanagers.com/wp-content/uploads/Acord-125.pdf                                                                                          | 2026-04-25  |
| `acord-126.pdf`  | ACORD 126 — Commercial General Liability Section | https://assets.ctfassets.net/lmppvj3zucf1/3thvcH3KndEPXGBZUJpBjO/b745445544c629df5ac8746e7c66c191/ACORD_126_-_Commercial_General_Liability_Section.pdf            | 2026-04-25  |

Before swapping in a new copy, verify it still has AcroForm fields (open in
Acrobat and confirm the inputs are interactive, not flattened image overlays).
`pnpm forms:extract` will also fail loudly if no form fields are present.
