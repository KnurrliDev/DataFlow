import * as assert from 'assert';
import { outlineGroups, paddingAfter, typeDefinitionLine } from '../../side/outline';
import type { SideOutlineData, SideOutlineMember } from '../../side/protocol';

// The panel of "Outline": the groups of the members, the padding after a data member, and the header of a type

suite('Outline of a type', () => {
	const member = (kind: SideOutlineMember['kind'], name: string, extra: Partial<SideOutlineMember> = {}): SideOutlineMember => ({
		kind, name, text: '', access: 'public', file: 'a.h', line: 1, col: 1, ...extra,
	});
	const outline = (extra: Partial<SideOutlineData> = {}): SideOutlineData => ({
		name: 'Battery', qualifiedName: 'power::Battery', kind: 'class', template: '', underlying: '', isFinal: false, isAbstract: false,
		isLibrary: false, isTruncated: false, file: 'a.h', line: 1, col: 1, bases: [], members: [], inherited: [], layout: null, ...extra,
	});

	test('The members go into groups by kind, by macro and by base, in the sequence of the source', () => {
		const o = outline({
			members: [
				member('type', 'State'), member('constructor', 'Battery'), member('field', 'capacity_'), member('method', 'StaticClass', { macro: 'GENERATED_BODY' }),
				member('method', 'charge'), member('field', 'id_', { macro: 'GENERATED_BODY' }), member('friend', 'Inspector'),
			],
			inherited: [{ base: 'Device', members: [member('method', 'tick')] }],
		});
		const { groups, hidden } = outlineGroups(o);
		assert.deepStrictEqual(groups.map((g) => [g.title, g.members.map((m) => m.name), g.isOpen]), [
			['Data members', ['capacity_'], true],
			['Functions', ['Battery', 'charge'], true],
			['Types', ['State'], true],
			['Friends', ['Inspector'], true],
			['Made by GENERATED_BODY', ['StaticClass', 'id_'], false],
			['Inherited from Device', ['tick'], false],
		]);
		assert.strictEqual(hidden, 0);
	});

	test('A library type hides its internal names that start with "_"', () => {
		const o = outline({
			isLibrary: true,
			members: [member('field', '_Mypair', { access: 'private' }), member('method', 'size')],
			inherited: [{ base: 'std::_Vector_val', members: [member('field', '_Myfirst')] }],
		});
		const { groups, hidden } = outlineGroups(o);
		assert.deepStrictEqual(groups.map((g) => [g.title, g.members.map((m) => m.name)]), [['Functions', ['size']], ['Inherited from std::_Vector_val', []]]);
		assert.strictEqual(hidden, 2);
	});

	test('The padding after a data member is the hole of the layout at its end', () => {
		const o = outline({ layout: { size: 32, align: 8, padding: 9, hasVPtr: false, holes: [{ offset: 12, size: 4 }, { offset: 27, size: 5 }] } });
		assert.strictEqual(paddingAfter(o, member('field', 'id_', { offset: 8, size: 4 })), 4);
		assert.strictEqual(paddingAfter(o, member('field', 'kw', { offset: 16, size: 8 })), 0);
		assert.strictEqual(paddingAfter(outline(), member('field', 'id_', { offset: 8, size: 4 })), 0);
	});

	test('The header search finds the definition of a type, also with an export macro, and not a forward declaration', () => {
		const text = [
			'class AActor;',
			'struct Plan;',
			'class ENGINE_API AActor : public UObject',
			'{',
			'};',
			'enum class EState : uint8 { Idle };',
			'struct Plan { int hours = 0; };',
		].join('\n');
		assert.strictEqual(typeDefinitionLine(text, 'AActor'), 2);
		assert.strictEqual(typeDefinitionLine(text, 'game::EState'), 5);
		assert.strictEqual(typeDefinitionLine(text, 'Plan'), 6);
		assert.strictEqual(typeDefinitionLine(text, 'Actor'), -1);
	});
});
