/**
 * The 85 simulated guests of the Riverside template, plus Jamie, the guest on the approved
 * screens. Paddle 142 is never simulated: in a demo it belongs to the person who started it.
 *
 * Holds reconcile with 12: with Jamie's $500 they total $43,950 over 86 bidders, the 19 winners
 * hold $11,500 and the 67 who win nothing hold $32,450. Names and holds of the ten winners on
 * 12's first page are as approved; the rest only have to add up.
 */
import { dollars } from "./cents";
import { CREATOR_PADDLE_NUMBER } from "./template";

export interface Guest {
  number: number;
  firstName: string;
  lastInitial: string;
  holdCents: number;
}

type GuestRow = [number: number, firstName: string, lastInitial: string, holdDollars: number];

const SIMULATED_ROWS: readonly GuestRow[] = [
  [88, "Harold", "B", 500],
  [90, "Felix", "M", 500],
  [92, "Joanna", "P", 250],
  [94, "Wesley", "T", 500],
  [96, "Camila", "R", 500],
  [98, "Dominic", "F", 500],
  [101, "Ruth", "A", 500],
  [102, "Victor", "H", 1_000],
  [103, "Lena", "S", 500],
  [104, "Elena", "R", 1_000],
  [105, "Omar", "J", 500],
  [106, "Tessa", "G", 500],
  [107, "Calvin", "W", 250],
  [108, "Meredith", "K", 750],
  [109, "Chris", "D", 250],
  [111, "Isaac", "L", 500],
  [112, "Grace", "T", 250],
  [113, "Beatrice", "N", 750],
  [114, "Andre", "C", 500],
  [115, "Lucia", "V", 500],
  [116, "Gordon", "E", 500],
  [117, "Priya", "N", 500],
  [118, "Sofia", "D", 500],
  [119, "Raymond", "Q", 1_000],
  [121, "Ben", "C", 750],
  [122, "Natalie", "B", 1_000],
  [123, "Hugo", "P", 500],
  [124, "Yasmin", "T", 500],
  [125, "Dennis", "O", 500],
  [126, "Samuel", "B", 250],
  [127, "Clara", "W", 500],
  [128, "Rafael", "S", 500],
  [129, "Monica", "J", 500],
  [131, "Walter", "G", 1_500],
  [132, "Imogen", "R", 500],
  [133, "Marcus", "L", 1_000],
  [134, "Patrick", "F", 750],
  [135, "Leila", "H", 500],
  [136, "Simon", "K", 250],
  [137, "Vera", "M", 500],
  [138, "Aisha", "K", 1_000],
  [139, "Gregory", "A", 1_000],
  [141, "Paloma", "C", 500],
  [143, "Everett", "D", 500],
  [144, "Talia", "S", 250],
  [145, "Russell", "N", 500],
  [146, "Esther", "L", 250],
  [147, "Leo", "W", 500],
  [148, "Brandon", "Y", 1_000],
  [149, "Frances", "W", 500],
  [151, "Hannah", "L", 250],
  [152, "Arjun", "P", 500],
  [153, "Delia", "M", 250],
  [154, "Quentin", "R", 500],
  [155, "Marisol", "G", 250],
  [156, "Nora", "F", 500],
  [157, "Jonah", "B", 500],
  [158, "Helena", "F", 500],
  [159, "Curtis", "T", 300],
  [161, "Ingrid", "H", 250],
  [162, "Malik", "E", 300],
  [163, "Diego", "A", 500],
  [164, "Rosalind", "C", 250],
  [165, "Stefan", "V", 1_000],
  [166, "June", "K", 300],
  [167, "Ezra", "L", 300],
  [168, "Owen", "P", 1_000],
  [169, "Noelle", "S", 250],
  [171, "Mateo", "G", 250],
  [172, "Abel", "R", 250],
  [173, "Kiara", "D", 250],
  [174, "Martin", "O", 250],
  [175, "Rosa", "M", 2_000],
  [176, "Lydia", "P", 250],
  [177, "Graham", "N", 750],
  [178, "Opal", "J", 250],
  [179, "Theo", "H", 500],
  [181, "Desmond", "W", 250],
  [182, "Celeste", "A", 250],
  [183, "Ronan", "M", 250],
  [184, "Wren", "T", 250],
  [185, "Iris", "W", 250],
  [186, "Silas", "B", 250],
  [187, "Mabel", "H", 250],
  [188, "Kenji", "O", 250],
];

function toGuest([number, firstName, lastInitial, holdDollars]: GuestRow): Guest {
  return { number, firstName, lastInitial, holdCents: dollars(holdDollars) };
}

export const SIMULATED_GUESTS: readonly Guest[] = SIMULATED_ROWS.map(toGuest);

/** The guest of the approved screens: $500 held with PayPal at 8:41 PM. */
export const JAMIE: Guest = toGuest([CREATOR_PADDLE_NUMBER, "Jamie", "K", 500]);

export function simulatedGuest(number: number): Guest {
  const guest = SIMULATED_GUESTS.find((candidate) => candidate.number === number);
  if (!guest) throw new RangeError(`No simulated guest holds paddle ${number}`);
  return guest;
}
