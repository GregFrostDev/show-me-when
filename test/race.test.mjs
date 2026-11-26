import test from 'node:test';
import assert from 'node:assert/strict';
import { raceVerdict } from '../tools/race.mjs';

test('race counts: the landed incident got the ack, not the row meant, with a receipt', () => {
  assert.equal(raceVerdict({ meant: 'INC-1', landed: 'INC-9', hit: 'INC-9', receipt: 'a1.x' }), null);
});
test('race fails: empty receipt', () => {
  assert.equal(raceVerdict({ meant: 'INC-1', landed: 'INC-9', hit: 'INC-9', receipt: ' ' }).field, 'receipt');
});
test('race fails: the click hit the row meant', () => {
  assert.equal(raceVerdict({ meant: 'INC-1', landed: 'INC-9', hit: 'INC-1', receipt: 'a1.x' }).field, 'race');
});
test('race fails: the click hit another row, not the landed one', () => {
  assert.equal(raceVerdict({ meant: 'INC-1', landed: 'INC-9', hit: 'INC-5', receipt: 'a1.x' }).field, 'race');
});
test('race fails: landed and hit missing', () => {
  assert.equal(raceVerdict({ meant: 'INC-1', landed: undefined, hit: '', receipt: 'a1.x' }).field, 'race');
});
test('step 2: the confirm caught the landed incident and the ack went to the row meant', () => {
  assert.equal(raceVerdict({ meant: 'INC-1', landed: 'INC-9', hit: 'INC-1', receipt: 'a1.x', caught: 'INC-9' }), null);
});
test('step 2 fails: the confirm caught it but the ack still went elsewhere', () => {
  assert.equal(raceVerdict({ meant: 'INC-1', landed: 'INC-9', hit: 'INC-9', receipt: 'a1.x', caught: 'INC-9' }).field, 'race');
});
