/**	Perform standard point buy method for character abilities.
 */
 
export class Wealth {
	actor = null;
	dlg = null;
	wealthDie = null;
	purchaseTable = [];

	async createDialog(actor) {
		this.actor = actor;

		//callback with no arguments declared, theses can be declared in the function definition
		//in that case we use a .bind(this) for the function (unless static) is specific to the instance it's in
		//also, keeping a reference to the hook index for later unregister

		let content =
			  `<style>
				td {
					text-align: center;
				}
				.left {
					text-align: left;
				}
			  </style>
			  <form>
			  <p id="prompt" height="60"></p>
			  <table>
				<tr>
					<th class="left">Totals</th>
					<th>Num</th>
					<th>Pts</th>
					<th>Avail</th>
				</tr>
				<tr>
					<td class="left">Attributes</td>
					<td id="numAttr"></td>
					<td id="ptsAttr"></td>
					<td id="availAttr"></td>
				</tr>
				<tr>
					<td class="left">Skills</td>
					<td id="numSkills"></td>
					<td id="ptsSkills"></td>
					<td id="availSkills"></td>
				</tr>
				<tr class="left">
					<td class="left">Edges</td>
					<td id="numEdges"></td>
					<td id="ptsEdges"></td>
					<td id="availEdges"></td>
				</tr>
				<tr>
					<td class="left">Hindrances</td>
					<td id="numHind"></td>
					<td id="ptsHind"></td>
					<td id="maxHind"></td>
				</tr>
				<tr>
					<td class="left">Advances</td>
					<td id="numAdv"></td>
					<td id="ptsAdv"></td>
					<td id="maxAdv"></td>
				</tr>
				<tr>
					<td class="left">TOTAL</td>
					<td></td>
					<td id="ptsTotal"></td>
					<td id="availTotal"></td>
				</tr>
			  </table>
			  <p>Total Price of Gear: <span id="totalPrice"></span>, Currency: <span id="currency"></span></p>
			</form>
		  `;
		
		async function handleRender(pb, html) {
			await pb.calcCost(html);
			html.on('change', html, (e) => {
				let html = e.data;
				switch (e.target.nodeName) {
				case 'INPUT':
					break;
				}
			});
		}

		let leaving = true;

		this.dlg = new Dialog({
		  title: `Check Character: ${this.actor.name}`,
		  content: content,
		  buttons: {
			cancel: {
			  label: "Done",
			  callback: (html) => {}
			},
		  },
		  close: () => {},
		  render: (html) => { handleRender(this, html); }
		});
		this.dlg.render(true);

		return true;
	}
	
	async setBaseWealth(actor) {
		if (actor.getFlag('swade-ws', 'baseWealth'))
			return;
		await actor.setFlag('swade-ws', 'baseWealth', actor.system.details.wealth.die);
	}

	async buy(item, sheet) {
		let actor = sheet.parent;
		if (actor.type != 'character')
			return;
		if (!item?.system?.price)
			return;

		await this.setBaseWealth(actor);
		
		if (actor.system.details.wealth.die <= 0) {
			const takeItAny = await Dialog.wait({
				title: `You Are Broke`,
				content: `You added ${item.name} to your Gear and you are Broke. Your Wealth die is 0.`,
				buttons: {
					add: { label: "Add Anyway", callback: (html) => (true) },
					dontAdd: { label: "Don't Add", callback: () => (false) },
				},
				close: () => ( false )
			});
			if (!takeItAny) {
				actor.deleteEmbeddedDocuments("Item", [item._id]);
			} else {
				ChatMessage.create({content: `You are <b>broke</b> and added ${item.name} anyway.`});
			}
			return;
		}
		
		// Build the wealth roll table based on the current wealth die.

		let wd = actor.system.details.wealth.die;
		if (this.wealthDie != wd) {
			const wt = game.settings.get('swade-ws', 'wealthtable');
			this.wealthDie = wd;
			const entries = wt.split(/ *, */);
			this.purchaseTable.length = 0;
			this.purchaseTable.push({cost: wd * entries[0], modifier: null});
			for (let i = 1; i < entries.length; i++) {
				let [cost, modifier] = entries[i].split(/ *: */);
				this.purchaseTable.push({cost: Number(cost), modifier: Number(modifier)});
			}
		}
		
		// Get the quantity of items bought from the player and whether
		// the item should be charged at all.
		
		let rollMod = 0;
		const quantity = await Dialog.wait({
			title: `Wealth Roll for ${item.name}`,
			content: `<div style="display: table"><div style="display: table-cell">Add how many ${item.name} (price: $${item.system.price}):&nbsp;&nbsp;</div><div style="display: table-cell"><input id="quantity" style="width: 30px" type="number" size="2" value="${item.system.quantity}"></input></div></div>
			<div style="display: table"><div style="display: table-cell">Modifier:&nbsp;&nbsp;</div><div style="display: table-cell"><input id="modifier" style="width: 30px" type="number" size="2" value="0"></input></div></div>`,
			buttons: {
				next: { label: "Wealth Roll", callback: (html) =>
					{
						rollMod = Number(html.find('#modifier').val());
						return Number(html.find('#quantity').val());
					}
				},
				noroll: { label: "No Wealth Roll", callback: () => (0) },
				remove: { label: "Remove Item", callback: () => (null) },
			},
			close: () => ( 0 )
		});		
		
		if (quantity == 0)
			return;
		if (quantity == null) {
			actor.deleteEmbeddedDocuments("Item", [item._id]);
			return;
		}
		
		let totalCost = item.system.price * quantity;

		let modifier = -10;
		for (let i = 0; i < this.purchaseTable.length; i++) {
			if (totalCost <= this.purchaseTable[i].cost) {
				modifier = this.purchaseTable[i].modifier;
				break;
			}
		}
		// Exit if cost is below the wealth threshhold.
		if (modifier === null) {
			// Track the number of minor purchases in the flags for the character.
			ui.notifications.notify(`The purchase of ${item.name} ($${totalCost}) is not large enough to warrant a Wealth Die roll.`);
			return;
		}
		
		modifier += rollMod;

		let done = false;
		let roll;
		let critFail;
		let rollSpec = `{1d${wd}x[Wealth Die],1d${actor.system.details.wealth['wild-die']}x[Wild Die]}kh + ${actor.system.details.wealth.modifier}[Wealth Modifier] + ${modifier}[Cost Modifier]`;

		while (!done) {
			roll = new Roll(rollSpec);
			await roll.evaluate();

			let results = roll.terms[0].results;
			let critFail = results[0].result == 1 && results[1].result == 1;
			// See if user wants to use a benny for reroll.
			let res;
			let outcome;
			if (critFail) {
				res = 'Critical Failure: must wait to make purchase.';
				outcome = 'Critical Failure';
			} else if (roll.total >= 8) {
				outcome = 'Success with raise';
			} else if (roll.total >= 4) {
				res = `Success: purchase will reduce Weath Die type (currently d${wd}).`;
				outcome = 'Success';
			} else {
				outcome = 'Failure';
				res = 'Failure: roll failed, you may Go Broke to purchase anyway.';
			}

			const text = `<b>${outcome}:</b> Wealth Roll to purchase ${quantity} of ${item.name}`;
			roll.toMessage({flavor: text}, {flavor: text});

			if (roll.total >= 8 || actor.system.bennies.value <= 0)
				break;

			outcome = await Dialog.wait({
				title: `Wealth Roll Result for ${item.name}`,
				content: `<p>${res}</p><p>&nbsp;&nbsp;&nbsp;Result: ${roll.total} = ${roll.result}</p><p>Bennies: ${actor.system.bennies.value}</p>`,
				buttons: {
					next: { label: "Use Roll", callback: (html) => (1) },
					reroll: { label: "Spend Benny to Reroll", callback: () => (0) }
				},
				close: () => ( 1 )
			});		
			if (outcome == -1)
				return;
			if (outcome == 1)
				done = true;
			else {
				await actor.update({[`system.bennies.value`]: actor.system.bennies.value - 1});
			}
		}

		// Send the result to the chat.

		let content;
		let deleteItem = false;

		if (critFail) {
			content = `The Wealth roll was a <b>critical failure</b>: ${roll.total} = ${roll.result}! You cannot buy ${item.name} x ${quantity} and may not make another Wealth roll for a week.`;
			deleteItem = true;
		} else if (roll.total < 4) {
			const buyItAnyway = await Dialog.wait({
				title: `Wealth Roll Failed`,
				content: `The Wealth roll for ${item.name} <b>failed</b>: ${roll.total} = ${roll.result}.`,
				buttons: {
					buy: { label: "Buy Anyway and Go Broke", callback: (html) => (true) },
					dontBuy: { label: "Don't Buy", callback: () => (false) },
				},
				close: () => ( false )
			});		
			if (buyItAnyway) {
				content = `You bought ${item.name} x ${quantity} and <b>went broke</b> after the Wealth roll failed: ${roll.total} = ${roll.result}.`;
				await actor.update({[`system.details.wealth.die`]: 0});
			} else {
				content = `You did not buy ${item.name} x ${quantity}. The Wealth roll failed: ${roll.total} = ${roll.result}.`;
				deleteItem = true;
			}
		} else if (roll.total < 8) {
			if (wd <= 4) {
				content = `You bought ${item.name} x ${quantity} and you went broke because your Wealth die was d4. Your Wealth roll <b>succeeded</b>: ${roll.total} = ${roll.result}.`;
				wd = 0;
			} else {
				wd -= 2;
				content = `You bought ${item.name} x ${quantity} and your Wealth die decreased by a die type to d${wd}. Wealth roll <b>succeeded</b>: ${roll.total} = ${roll.result}.`;
			}
			await actor.update({[`system.details.wealth.die`]: wd});
		} else {
			ui.notifications.notify('Wealth Roll was a raise!');
			content = `You bought ${item.name} x ${quantity} and your Wealth die is unchanged. Wealth roll was a <b>raise</b>: ${roll.total} = ${roll.result}.`;
		}

		if (deleteItem) {
			await actor.deleteEmbeddedDocuments("Item", [item._id]);
		} else {
			// Make sure the quantity is right.
			if (quantity != item.system.quantity) {
				await actor.updateEmbeddedDocuments("Item", [{ "_id": item._id, ['system.quantity']: quantity }]);
			}
		}

		ChatMessage.create({content: content});
	}
	
	init() {
		
	}

	finish() {
	}
	
	async wealthSupport(actor) {
		let wd = actor.system.details.wealth.die;
		if (wd == 0) {
			ui.notifications.notify(`${actor.name} is Broke and cannot make a Wealth roll.`);
			return;
		}
		let done = false;
		let roll;
		let critFail;
		let rollSpec = `{1d${wd}x[Wealth Die],1d${actor.system.details.wealth['wild-die']}x[Wild Die]}kh + ${actor.system.details.wealth.modifier}[Wealth Modifier]`;

		while (!done) {
			roll = new Roll(rollSpec);
			await roll.evaluate();
			const text = `Wealth Roll to support another character's Wealth roll.`;
			let msg = await roll.toMessage({flavor: text}, {flavor: text});

			let results = roll.terms[0].results;
			let critFail = results[0].result == 1 && results[1].result == 1;
			if (roll.total >= 8)
				break;
			if (actor.system.bennies.value <= 0)
				break;
			// See if user wants to use a benny for reroll.
			let res;
			if (critFail)
				res = 'Critical Failure: must wait to make purchase.';
			else if (roll.total >= 4)
				res = `Success: purchase will reduce Weath Die type (currently d${wd}).`;
			else
				res = 'Failure: roll failed, you may Go Broke to purchase anyway.';
			const outcome = await Dialog.wait({
				title: `Support Wealth Roll Result`,
				content: `<p>${res}</p><p>&nbsp;&nbsp;&nbsp;Result: ${roll.total} = ${roll.result}</p><p>Bennies: ${actor.system.bennies.value}</p>`,
				buttons: {
					next: { label: "Use Roll", callback: (html) => (1) },
					reroll: { label: "Spend Benny to Reroll", callback: () => (0) }
				},
				close: () => ( 1 )
			});		
			if (outcome == -1)
				return;
			if (outcome == 1)
				done = true;
			else {
				await actor.update({[`system.bennies.value`]: actor.system.bennies.value - 1});
			}
		}
	}
	
	async manage(actor) {
		await this.setBaseWealth(actor);
		let reward = 0;
		let baseWealthDie = "";

		let bwd = actor.getFlag('swade-ws', 'baseWealth');
		let wd = actor.system.details.wealth.die;

		const action = await Dialog.wait({
			title: `Manage Wealth: ${actor.name}`,
			content: `<p>Current Wealth Die: ${wd==0?'Broke':'d'+wd}, Base Wealth Die: d${bwd}.</p>
			<p>To grant a Reward to the character enter a value in Reward and click Add Reward. This will increase the Wealth die by the indicated number of die types (maximum of d12).</p>
			<p>To adjust the Wealth Die up for the passage of time, click Adjust Wealth.</p>
			<p>To set the Base Wealth Die (the permanent value) enter a value in Base Wealth Die and click Set Base Wealth.</p>
			<p>To make a Wealth Die support roll to give another character a +1 modifier on their Wealth roll click Support Roll.</p>
			<div style="display: table"><div style="display: table-cell">Reward:&nbsp;&nbsp;</div><div style="display: table-cell"><input id="reward" style="width: 30px" type="number" size="2" value="0"></input></div></div>
			<div style="display: table"><div style="display: table-cell">Base Wealth Die:&nbsp;&nbsp;</div><div style="display: table-cell"><input id="base" style="width: 30px" type="text" size="4" value=""></input></div></div>`,
			buttons: {
				next:
				{ label: "Add Reward", callback: (html) =>
					{
						reward = Number(html.find('#reward').val());
						return 'reward';
					}
				},
				adjust: { label: "Adjust Wealth", callback: () => ('adjust') },
				set: { label: "Set Base Wealth", callback: (html) => 
					{
						baseWealthDie = html.find('#base').val();
						return 'set';
					}
				},
				support: {label: "Support Roll", callback: () => ('support')},
				cancel: { label: "Cancel", callback: () => ('cancel') },
			},
			close: () => ( 'cancel' )
		}, "", {width: 600});
		switch (action) {
		case 'reward':
			if (reward == 0) {
				ui.notifications.notify("Enter a value in Rewards.");
				return;
			}
			this.reward(actor, reward);
			ChatMessage.create({content: `${actor.name} received  ${reward} reward(s).`});
			break;
		case 'adjust':
			await this.adjust(actor);
			if (actor.system.details.wealth.die != wd)
				ChatMessage.create({content: `Adjusted ${actor.name}'s wealth die to d${actor.system.details.wealth.die}`});
			else
				ui.notifications.notify(`${actor.name}'s Wealth Die unchanged at ${wd}.`);
			break;
		case 'set':
			if (baseWealthDie == "") {
				ui.notifications.notify("Enter a value in Base Wealth Die.");
				return;
			}

			const base = Number(baseWealthDie.replaceAll(/[^0-9]+/g, ''));
			switch (base) {
			case 4: case 6: case 8: case 10: case 12:
				await actor.update({[`system.details.wealth.die`]: base});
				await actor.setFlag('swade-ws', 'baseWealth', base);
				ui.notifications.notify(`Set ${actor.name}'s wealth die to d${base}`);
				break;
			default:
				ui.notifications.notify("Base Wealth Die must be d4, d6, d8, d10 or d12.");
				break;
			}
			break;
		case 'support':
			this.wealthSupport(actor);
			break;
		}
	}
	
	async reward(actor, rewards) {
		// Add a reward to the selected actors, increasing the die type temporarily.
		await this.setBaseWealth(actor);
		let wd = actor.system.details.wealth.die;
		switch (wd) {
		case 12:
			return;
		default:
		case 0:
			wd = 2;
		case 4: case 6: case 8: case 10:
			wd = Math.min(12, wd + rewards * 2);
			break;
		}
		await actor.update({[`system.details.wealth.die`]: wd});
	}

	async adjust(actor) {
		await this.setBaseWealth(actor);
		let baseWealthDie = actor.getFlag('swade-ws', 'baseWealth');
		let wd = actor.system.details.wealth.die;
		if (wd == baseWealthDie)
			return 0;
		// Adjust the wealth die up if lower than base.
		if (wd < baseWealthDie) {
			if (wd <= 0)
				wd = 2;
			wd += 2;
		}
		await actor.update({[`system.details.wealth.die`]: wd});
		return 1;
	}

	async adjustTokens() {
		let n = 0;
		for (let token of canvas.tokens.controlled) {
			let actor = token.actor;
			if (actor.type == 'character') {
				n += await this.adjust(actor);
			}
		}
		ui.notifications.notify(`Adjusted Wealth Die of ${n} character(s)`);
	}

	async rewardTokens() {
		const reward = await Dialog.wait({
			title: `Wealth Reward`,
			content: `<div style="display: table"><div style="display: table-cell">Reward to grant:&nbsp;&nbsp;</div><div style="display: table-cell"><input style="width: 30px" type="number" size="2" value="1"></input></div></div>`,
			buttons: {
				next: { label: "Grant Reward", callback: (html) => Number(html.find('input').val()) },
				remove: { label: "Cancel", callback: () => (0) },
			},
			close: () => ( 0 )
		});
		if (reward == 0)
			return;
		
		let n = 0;
		for (let token of canvas.tokens.controlled) {
			let actor = token.actor;
			if (actor.type == 'character') {
				this.reward(actor, reward);
				n++;
			}
		}
		ui.notifications.notify(`Gave ${n} character(s) ${reward} reward(s)`);
	}

	static {
		console.log("swade-ws | Swade Character Check loaded.");

		Hooks.on("init", function() {
		  console.log("swade-ws | Swade Character Check initialized.");
		});

		Hooks.on("ready", function() {
		  console.log("swade-ws | Swade Character Check ready to accept game data.");
		});
	}
}


/*
 * Create the configuration settings.
 */
Hooks.once('init', async function () {
	game.settings.register('swade-ws', 'wealthtable', {
	  name: 'Wealth Table',
	  hint: '10 (weath die multiplier for no charge), value1:modifier1, value2:modifier2, ...',
	  scope: 'world',     // "world" = sync to db, "client" = local storage
	  config: true,       // false if you dont want it to show in module config
	  type: String,       // Number, Boolean, String, Object
	  default: "10, 500:+1, 1000:0, 2000:-1, 4000:-2, 8000:-3, 16000:-4, 32000:-5, 64000:-6, 128000:-7, 256000:-8, 512000:-9",
	  onChange: value => { // value is the new value of the setting
		//console.log('swade-ws | budget: ' + value)
	  }
	});

	if (!game.SwadeWealth) {
		game.SwadeWealth = new Wealth();
		game.SwadeWealth.init();
	}
	
});


Hooks.on("createItem", async function(item, sheet, data) {
	// Exit immediately if item was created by another user.
	if (data != game.user.id || !item.parent)
		return;
	await game.SwadeWealth.buy(item, sheet);
});


function insertActorHeaderButtons(actorSheet, buttons) {
  let actor = actorSheet.object;
  if (actor.type != 'character')
	  return;
  buttons.unshift({
    label: "Wealth",
    icon: "fas fa-dollar",
    class: "wealth-button",
    onclick: async () => {
		try {
			game.SwadeWealth.manage(actor);
		} catch (msg) {
			ui.notifications.warn(msg);
		}

    }
  });
}

Hooks.on("getActorSheetHeaderButtons", insertActorHeaderButtons);
