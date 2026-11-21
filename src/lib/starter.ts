// One-tap starting points. Every channel here mostly publishes long-form videos.
// Want to suggest a channel? Open a pull request that edits this list.

export type Pack = { name: string; about: string; channels: { id: string; title: string }[] };

const pack = (name: string, about: string, channels: [string, string][]): Pack => ({
  name,
  about,
  channels: channels.map(([id, title]) => ({ id, title })),
});

export const STARTER_PACKS: Pack[] = [
  pack("Podcasts", "Long conversations with people who know things", [
    ["UCSHZKyawb77ixDdsGog4iWA", "Lex Fridman"],
    ["UCXl4i9dYBrFOabk0xGmbkRA", "Dwarkesh Patel"],
    ["UCyFqFYfTW2VoIQKylJ04Rtw", "Acquired"],
    ["UC2D2CMWXMOVWx7giW1n3LIg", "Andrew Huberman"],
    ["UCznv7Vf9nBdJYvBagFdAHWw", "Tim Ferriss"],
    ["UC8kGsMa0LygSX9nkBcBH1Sg", "Peter Attia MD"],
    ["UC_AnpBvnhXTcipgGEHLWoOg", "Conversations with Tyler"],
    ["UCRhV1rWIpm_pU19bBm_2RXw", "Sean Carroll"],
  ]),
  pack("AI & Tech", "How the technology works, from the people building it", [
    ["UCXUPKJO5MZQN11PqgIvyuvQ", "Andrej Karpathy"],
    ["UCMLtBahI5DMrt0NPvDSoIRQ", "Machine Learning Street Talk"],
    ["UCxBcwypKK-W3GHd_RZ9FZrQ", "Latent Space"],
    ["UCSI7h9hydQ40K5MJHnCrQvw", "No Priors"],
    ["UCPbwhExawYrn9xxI21TFfyw", "The Pragmatic Engineer"],
    ["UCcefcZRL2oaA_uBNeo5UOWg", "Y Combinator"],
    ["UCYO_jab_esuFRV4b17AJtAw", "3Blue1Brown"],
  ]),
  pack("Lectures & Science", "University courses and serious explainers", [
    ["UCBa5G_ESCn8Yd4vw5U-gIcg", "Stanford Online"],
    ["UCEBb1b_L6zDS3xTUrIALZOw", "MIT OpenCourseWare"],
    ["UCwiykapHjd-Tj-anD2iuPAA", "Royal Institution"],
    ["UC7_gcs09iThXybpVgjHZ_7g", "PBS Space Time"],
    ["UCHnyfMqiRRG1u-2MsSQLbXA", "Veritasium"],
    ["UCMmaBzfCCwZ2KqaBJjkj0fw", "Kings and Generals"],
  ]),
  pack("Business", "Founders, investors, and how companies are built", [
    ["UC6t1O76G0jYXOAoYCm153dA", "Lenny's Podcast"],
    ["UC9cn0TuPq4dnbTY-CBsm8XA", "a16z"],
    ["UCf0PBRjhf0rF8fWBIxTuoWA", "20VC"],
    ["UCWrF0oN6unbXrWsTN7RctTw", "Sequoia Capital"],
    ["UCyaN6mg5u8Cjy2ZI4ikWaug", "My First Million"],
    ["UCESLZhusAkFfsNsApnjF_Cg", "All-In Podcast"],
  ]),
];
