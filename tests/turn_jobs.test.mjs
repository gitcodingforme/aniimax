import assert from 'node:assert/strict';
import test from 'node:test';

import { allocateTurnFacilities, allocateTurnJobs, redistributeTurnFacilityRows } from '../web/turn-jobs.js';

const row = (item_name, busy_units, facility_count = 1) => ({
    item_name,
    busy_units,
    facility_count,
    cycle_time: 10,
});

test('separates two recipes when two units of any facility are owned', () => {
    const machines = allocateTurnJobs([row('rough_lumber', 0.6), row('standard_planks', 0.4)], 2);
    assert.deepEqual(machines.map(jobs => jobs.map(job => job.item)), [['rough_lumber'], ['standard_planks']]);
});

test('shares tier recipes when only one unit is owned', () => {
    const machines = allocateTurnJobs([row('rough_lumber', 0.6), row('standard_planks', 0.4)], 1);
    assert.deepEqual(machines.map(jobs => jobs.map(job => job.item)), [['rough_lumber', 'standard_planks']]);
    assert.equal(machines[0].reduce((sum, job) => sum + job.rate * job.cycle, 0), 1);
});

test('splits workloads above one unit without exceeding owned capacity', () => {
    const machines = allocateTurnJobs([row('rough_lumber', 1.2, 2), row('standard_planks', 0.6)], 2);
    assert.equal(machines.length, 2);
    machines.forEach(jobs => assert.ok(jobs.reduce((sum, job) => sum + job.rate * job.cycle, 0) <= 1 + 1e-9));
    assert.equal(machines.flat().filter(job => job.item === 'rough_lumber').reduce((sum, job) => sum + job.rate * job.cycle, 0), 1.2);
    assert.equal(machines.flat().filter(job => job.item === 'standard_planks').reduce((sum, job) => sum + job.rate * job.cycle, 0), 0.6);
});

test('complete layout never exceeds owned units when the plan also contains an idle row', () => {
    const planRows = [
        row('rough_lumber', 0.6),
        row('standard_planks', 0.4),
        { item_name: null, busy_units: null, facility_count: 1, cycle_time: null, status: 'idle' },
    ];
    const machines = allocateTurnJobs(planRows, 2);

    assert.equal(machines.length, 2);
    assert.deepEqual(machines.map(jobs => jobs.map(job => job.item)), [['rough_lumber'], ['standard_planks']]);
});

test('complete layout includes idle physical units up to the owned count', () => {
    const machines = allocateTurnJobs([row('rough_lumber', 0.5)], 2);

    assert.equal(machines.length, 2);
    assert.deepEqual(machines.map(jobs => jobs.map(job => job.item)), [['rough_lumber'], []]);
});

test('RV 10 layout contains exactly the two owned Benches and Kilns despite idle plan rows', () => {
    const producing = (facility, item, busy) => ({ ...row(item, busy), facility, status: 'producing', turns: true });
    const idle = facility => ({ facility, item_name: null, facility_count: 1, cycle_time: null, status: 'idle' });
    const steps = [
        producing('Woodworking Bench', 'rough_lumber', 0.6),
        producing('Woodworking Bench', 'standard_planks', 0.4),
        idle('Woodworking Bench'),
        producing('Chimney Kiln', 'coarse_sifted_ore', 0.55),
        producing('Chimney Kiln', 'sintered_ore_brick', 0.45),
        idle('Chimney Kiln'),
    ];

    const layout = allocateTurnFacilities(steps, () => 2, step => step.status === 'producing' && step.turns);

    assert.equal(layout.get('Woodworking Bench').length, 2);
    assert.equal(layout.get('Chimney Kiln').length, 2);
    assert.equal([...layout.values()].reduce((sum, units) => sum + units.length, 0), 4);
});

test('facility table removes stale idle rows after recipes use every owned unit', () => {
    const producing = (facility, item, busy) => ({ ...row(item, busy), facility, status: 'producing', turns: true });
    const idle = facility => ({ facility, item_name: null, facility_count: 1, cycle_time: null, status: 'idle' });
    const steps = [
        producing('Woodworking Bench', 'rough_lumber', 0.6),
        producing('Woodworking Bench', 'standard_planks', 0.4),
        idle('Woodworking Bench'),
        producing('Chimney Kiln', 'coarse_sifted_ore', 0.55),
        producing('Chimney Kiln', 'sintered_ore_brick', 0.45),
        idle('Chimney Kiln'),
    ];

    const shown = redistributeTurnFacilityRows(steps, () => 2, step => step.status === 'producing' && step.turns);

    for (const facility of ['Woodworking Bench', 'Chimney Kiln']) {
        const rows = shown.filter(step => step.facility === facility);
        assert.equal(rows.reduce((sum, step) => sum + step.facility_count, 0), 2);
        assert.ok(rows.every(step => step.status === 'producing'));
    }
});

test('facility table keeps only the physical units that remain idle', () => {
    const steps = [
        { ...row('tier_1', 0.5), facility: 'Any Facility', status: 'producing', turns: true },
        { facility: 'Any Facility', item_name: null, facility_count: 2, cycle_time: null, status: 'idle' },
    ];

    const shown = redistributeTurnFacilityRows(steps, () => 3, step => step.status === 'producing' && step.turns);
    const idle = shown.find(step => step.status === 'idle');
    assert.equal(shown.reduce((sum, step) => sum + step.facility_count, 0), 3);
    assert.equal(idle.facility_count, 2);
});

test('E-mode Bench units are a pool of their own, sized from the plan\'s power', () => {
    const takesTurns = step => step.facility === 'Woodworking Bench';
    const bench = (item_name, busy_units, extra = {}) => ({ facility: 'Woodworking Bench', status: 'producing', item_name, busy_units, facility_count: 1, cycle_time: 30, ...extra });
    const steps = [
        bench('rough_lumber', 0.6),
        bench('standard_planks', 0.3),
        bench('rough_lumber', 0.5, { electric: true, cycle_time: 27 }),
        { facility: 'Woodworking Bench', status: 'idle', item_name: null, facility_count: 1, cycle_time: null },
    ];
    const power = { used: 15, budget: 600, supply: 100, units: [{ facility: 'Woodworking Bench', level: 1, count: 1, draw: 15 }] };
    const units = allocateTurnFacilities(steps, () => 4, takesTurns, power).get('Woodworking Bench');
    assert.equal(units.length, 4);
    const onPower = units.filter(jobs => jobs.some(job => job.electric));
    assert.equal(onPower.length, 1, 'one unit runs on power');
    assert.ok(onPower[0].every(job => job.electric && job.item === 'rough_lumber' && job.cycle === 27));
    const worked = units.filter(jobs => jobs.length && !jobs.some(job => job.electric));
    assert.deepEqual(worked.map(jobs => jobs.map(job => job.item)), [['rough_lumber'], ['standard_planks']], 'the Aniimo-worked tiers get their own units');
    assert.ok(units.flat().filter(job => !job.electric).every(job => job.cycle === 30));
    // The idle row shrinks to the one unit nothing uses.
    const shown = redistributeTurnFacilityRows(steps, () => 4, takesTurns, power);
    assert.deepEqual(shown.filter(s => s.status === 'idle').map(s => s.facility_count), [1]);
    // With only two units, the Aniimo-worked tiers share the one left over from power.
    const two = allocateTurnFacilities(steps, () => 2, takesTurns, power).get('Woodworking Bench');
    assert.deepEqual(two.map(jobs => jobs.map(job => `${job.item}${job.electric ? ' (E)' : ''}`)), [['rough_lumber', 'standard_planks'], ['rough_lumber (E)']]);
    // Without the plan's power, the E-mode rows get as many units as their workload needs.
    const guessed = allocateTurnFacilities(steps, () => 4, takesTurns).get('Woodworking Bench');
    assert.equal(guessed.filter(jobs => jobs.some(job => job.electric)).length, 1);
    // A plan without E-mode is allocated exactly as before.
    const plain = steps.filter(s => !s.electric);
    assert.deepEqual(allocateTurnFacilities(plain, () => 4, takesTurns, power), allocateTurnFacilities(plain, () => 4, takesTurns));
});
