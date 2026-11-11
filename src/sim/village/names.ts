// Names for the people of the village. A household shares a family name; given
// names are drawn without repeats until the list runs out.

import type { Rng } from '../../core/rng';

const GIVEN = [
  'Aldric', 'Beatrix', 'Cedany', 'Darrow', 'Edith', 'Fenn', 'Gisela', 'Hollis', 'Isolde', 'Jory', 'Kestrel', 'Leofric',
  'Maud', 'Nesta', 'Osric', 'Petra', 'Quenby', 'Rowena', 'Sorrel', 'Tobias', 'Una', 'Wilmot', 'Ysolt', 'Alys', 'Bram',
  'Corin', 'Dunstan', 'Elowen', 'Garrick', 'Hester', 'Ivo', 'Jocelyn', 'Kitt', 'Linnet', 'Merrick', 'Odo', 'Piers',
  'Rhosyn', 'Sabin', 'Tamsin', 'Wystan', 'Anselm', 'Brenna', 'Godric', 'Hilda', 'Lowen', 'Marian', 'Oswin', 'Thea', 'Wren',
  'Emmot', 'Faramond', 'Ricard', 'Sibyl', 'Avice', 'Hamo', 'Idony', 'Jenkin', 'Mabel', 'Warin',
];

const FAMILY = [
  'Ashdown', 'Barrow', 'Coombe', 'Dunmere', 'Eastbrook', 'Fallowell', 'Greaves', 'Harrow', 'Ings', 'Kettlewell', 'Langmoor',
  'Marlow', 'Netherby', 'Oakhurst', 'Penhallow', 'Quarrier', 'Redfern', 'Saltmarsh', 'Thornley', 'Underhill', 'Varley',
  'Wainfleet', 'Yarrow', 'Aldgrave', 'Briarley', 'Catterick', 'Dowsett', 'Elmstead', 'Fenwick', 'Gorsley', 'Hazelrigg',
  'Linton', 'Merrow', 'Northey', 'Pellow', 'Rushby', 'Stanmoor', 'Tidwell', 'Wolds',
];

export class Namer {
  private readonly given: string[];
  private readonly family: string[];
  private nextGiven = 0;
  private nextFamily = 0;

  constructor(rng: Rng) {
    this.given = rng.shuffle(GIVEN.slice());
    this.family = rng.shuffle(FAMILY.slice());
  }

  familyName(): string {
    const name = this.family[this.nextFamily % this.family.length] as string;
    this.nextFamily++;
    return name;
  }

  givenName(): string {
    const name = this.given[this.nextGiven % this.given.length] as string;
    this.nextGiven++;
    return name;
  }
}
