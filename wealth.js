/**	Perform standard point buy method for character abilities.
 */
 
export class Wealth {
	actor = null;
	dlg = null;
	wealthDie = null;
	purchaseTable = [];

	async setBaseWealth(actor) {
		if (actor.getFlag('swade-ws', 'baseWealth'))
			return;
		await actor.setFlag('swade-ws', 'baseWealth', actor.system.details.wealth.die);
	}

	async buy(item, sheet) {
		let actor = sheet.parent;
		if (actor.type != 'character' && actor.type != 'npc')
			return;
		if (!item?.system?.price)
			return;

		await this.setBaseWealth(actor);
		
		if (actor.system.details.wealth.die <= 0) {
			const takeItAnyway = await Dialog.wait({
				title: `${actor.name} Is Broke`,
				content: `${actor.name} added ${item.name} to Gear and is <b>Broke</b>.`,
				buttons: {
					add: { label: "Add Anyway", callback: (html) => (true) },
					dontAdd: { label: "Don't Add", callback: () => (false) },
				},
				close: () => ( false )
			});
			if (!takeItAnyway) {
				actor.deleteEmbeddedDocuments("Item", [item._id]);
			} else {
				ChatMessage.create({content: `${actor.name} is <b>broke</b> and added ${item.name} anyway.`});
			}
			return;
		}
		
		// Build the wealth roll table based on the current wealth die.
		
		let wd = actor.system.details.wealth.die;
		let incidentals = wd * game.settings.get('swade-ws', 'incidentals');

		if (this.wealthDie != wd) {
			const wt = game.settings.get('swade-ws', 'wealthtable');
			this.wealthDie = wd;
			const entries = wt.split(/ *, */);
			this.purchaseTable.length = 0;
			for (let i = 0; i < entries.length; i++) {
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
			<div style="display: table"><div style="display: table-cell">Modifier:&nbsp;&nbsp;</div><div style="display: table-cell"><input id="modifier" style="width: 30px" type="number" size="2" value="0"></input></div></div><br>`,
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
		
		if (quantity <= 0 && quantity !== null)
			return;

		let totalCost = item.system.price * quantity;

		let maximum = game.settings.get('swade-ws', 'maximum');
		if (totalCost > maximum) {
			ChatMessage.create({content: `The cost of ${item.name} x ${quantity} ($${totalCost}) exceeds the maximum allowed for a Wealth roll ($${maximum}).`});
			quantity = null;
		}

		if (quantity == null) {
			actor.deleteEmbeddedDocuments("Item", [item._id]);
			return;
		}

		// Exit if cost is below the wealth threshhold.
		if (totalCost < incidentals) {
			// Track the number of minor purchases in the flags for the character.
			ChatMessage.create({content: `The purchase of ${item.name} ($${totalCost}) is not large enough to warrant a Wealth Die roll.`});
			return;
		}

		let modifier = 0;
		for (let i = 0; i < this.purchaseTable.length; i++) {
			modifier = this.purchaseTable[i].modifier;
			if (totalCost <= this.purchaseTable[i].cost)
				break;
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
				res = 'Failure: roll failed, Go Broke to purchase anyway.';
			}

			const text = `<b>${outcome}:</b> Wealth Roll to purchase ${item.name} x ${quantity}.`;
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
				ChatMessage.create({content: `${actor.name} spent a Benny to reroll Wealth.`});
			}
		}

		// Send the result to the chat, deal with any reductions to Wealth Die, etc.

		let content;
		let deleteItem = false;

		if (critFail) {
			const critfailwait = game.settings.get('swade-ws', 'critfailwait');
			content = `The Wealth roll was a <b>critical failure</b>: ${roll.total} = ${roll.result}! ${actor.name} cannot buy ${item.name} x ${quantity} and may not make another Wealth roll for ${critfailwait}.`;
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
				content = `${actor.name} bought ${item.name} x ${quantity} and <b>went broke</b> after the Wealth roll failed: ${roll.total} = ${roll.result}.`;
				await actor.update({[`system.details.wealth.die`]: 0});
			} else {
				content = `${actor.name} did not buy ${item.name} x ${quantity}. The Wealth roll failed: ${roll.total} = ${roll.result}.`;
				deleteItem = true;
			}
		} else if (roll.total < 8) {
			if (wd <= 4) {
				const goBroke = await Dialog.confirm({
				  title: "Go Broke?",
				  content: `<p>Wealth Support roll succeeded: ${roll.total} = ${roll.result}, but Wealth Die is d4. Should ${actor.name} <b>go broke</b> for Wealth Support roll?</p>
				  <p>Click Yes to Go Broke, No to cancel purchase and remove  ${item.name}.</p>`,
				  yes: (html) => { return true; },
				  no: (html) => { return false; }
				});
				if (!goBroke) {
					await actor.deleteEmbeddedDocuments("Item", [item._id]);
					return;
				}

				content = `${actor.name} bought ${item.name} x ${quantity} and ${actor.name} <b>went broke</b> because the Wealth die was d4. The Wealth roll <b>succeeded</b>: ${roll.total} = ${roll.result}.`;
				wd = 0;
			} else {
				wd -= 2;
				content = `${actor.name} bought ${item.name} x ${quantity}. Wealth die decreased by a die type to d${wd}. Wealth roll <b>succeeded</b>: ${roll.total} = ${roll.result}.`;
			}
			await actor.update({[`system.details.wealth.die`]: wd});
		} else {
			ui.notifications.notify('Wealth Roll was a raise!');
			content = `${actor.name} bought ${item.name} x ${quantity}. Wealth die is unchanged. Wealth roll was a <b>raise</b>: ${roll.total} = ${roll.result}.`;
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
			critFail = results[0].result == 1 && results[1].result == 1;
			if (roll.total >= 8)
				break;
			if (actor.system.bennies.value <= 0)
				break;
			// See if user wants to use a benny for reroll.
			let res;
			if (critFail)
				res = `Critical Failure: must wait ${game.settings.get('swade-ws', 'critfailwait')}.`;
			else if (roll.total >= 4)
				res = `Success: reduce Weath Die type (currently d${wd}).`;
			else
				res = 'Failure: Go Broke or Cancel.';
			const outcome = await Dialog.wait({
				title: `Support Wealth Roll Result`,
				content: `<p>${res}</p><p>&nbsp;&nbsp;&nbsp;Result: ${roll.total} = ${roll.result}</p><p>Bennies: ${actor.system.bennies.value}</p>`,
				buttons: {
					next: { label: "Use Roll", callback: (html) => (1) },
					reroll: { label: "Spend Benny to Reroll", callback: () => (0) },
					cancel: { label: "Cancel", callback: () => (-1) }
				},
				close: () => ( 1 )
			}, "", {width: 600});		
			if (outcome == -1)
				return;
			if (outcome == 1)
				done = true;
			else {
				await actor.update({[`system.bennies.value`]: actor.system.bennies.value - 1});
				ChatMessage.create({content: `${actor.name} spent Benny to suppoert Wealth roll.`});
			}
		}
		if (critFail) {
			ChatMessage.create({content: `${actor.name}: Wealth Support roll was a <b>critical failure</b>. Must wait ${game.settings.get('swade-ws', 'critfailwait')} to try again.`});
			return;
		}
		if (roll.total >= 8) {
			ChatMessage.create({content: `${actor.name} <b>succeeded</b> Wealth Support roll with a <b>raise</b>. Add 1 to other character's Wealth roll.`});
			return;
		}
		let message;
		if (roll.total >= 4) {
			wd -= 2;
			if (wd <= 2) {
				const goBroke = await Dialog.confirm({
				  title: "Go Broke?",
				  content: `<p>Wealth Support roll succeeded: ${roll.total} = ${roll.result}, but Wealth Die is d4. Should ${actor.name} <b>go broke</b> for Wealth Support roll?</p>`,
				  yes: (html) => { return true; },
				  no: (html) => { return false; }
				});
				if (!goBroke)
					return;
				
				wd = 0;
				message = `${actor.name}: Wealth Support roll <b>succeeded</b>: ${roll.total} = ${roll.result}, but <b>went broke</b>.`;
			} else {
				message = `${actor.name}: Wealth Support roll <b>succeeded</b>: ${roll.total} = ${roll.result}. Wealth die reduced to d${wd}.`;
			}
		} else {
			const goBroke = await Dialog.confirm({
			  title: "Go Broke?",
			  content: `<p>Wealth Support roll failed: ${roll.total} = ${roll.result}. Should ${actor.name} <b>go broke</b> for Wealth Support roll?</p>`,
			  yes: (html) => { return true; },
			  no: (html) => { return false; }
			});
			if (!goBroke)
				return;
			wd = 0;
			message = `${actor.name}: Wealth Support roll <b>failed</b>: ${roll.total} = ${roll.result} and <b>went broke</b>.`;
		}
		ChatMessage.create({content: message + " Add 1 to other character's Wealth roll."});
		await actor.update({[`system.details.wealth.die`]: wd});
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
			<p>To adjust the Wealth Die up or down for the passage of time, click Adjust Wealth.</p>
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
				ChatMessage.create({content: `Adjusted ${actor.name}'s wealth die to d${actor.system.details.wealth.die} for the passage of time.`});
			else
				ui.notifications.notify(`${actor.name}'s Wealth Die unchanged at d${wd}.`);
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
		// Adjust the wealth die up if lower than base, down if higher.
		if (wd < baseWealthDie) {
			if (wd <= 0)
				wd = 2;
			wd += 2;
		} else
			wd -= 2;
		await actor.update({[`system.details.wealth.die`]: wd});
		return 1;
	}

	async adjustTokens() {
		let n = 0;
		for (let token of canvas.tokens.controlled) {
			let actor = token.actor;
			if (actor.type == 'character' || actor.type == 'npc') {
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
			if (actor.type == 'character' || actor.type == 'npc') {
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
	game.settings.register('swade-ws', 'rollwealth', {
	  name: 'Wealth Rolls',
	  hint: 'Make Wealth rolls when items with a non-zero price are added to characters.',
	  scope: 'world',     // "world" = sync to db, "client" = local storage
	  config: true,       // false if you dont want it to show in module config
	  type: Boolean,       // Number, Boolean, String, Object
	  default: false,
	  onChange: value => { // value is the new value of the setting
	  }
	});
	game.settings.register('swade-ws', 'wealthtable', {
	  name: 'Wealth Table',
	  hint: 'List of value:modifier entries separated by commas. If item price <= value, modifier is applied to the wealth roll.',
	  scope: 'world',     // "world" = sync to db, "client" = local storage
	  config: true,       // false if you dont want it to show in module config
	  type: String,       // Number, Boolean, String, Object
	  default: "500:+1, 1000:0, 2000:-1, 4000:-2, 8000:-3, 16000:-4, 32000:-5, 64000:-6, 128000:-7, 256000:-8, 512000:-9, 1000000,-10",
	  onChange: value => { // value is the new value of the setting
	  }
	});
	game.settings.register('swade-ws', 'incidentals', {
	  name: 'Incidentals Limit',
	  hint: 'Multiplier for the wealth die: if an item with a price less than this value times the Wealth Die is added no roll is made.',
	  scope: 'world',     // "world" = sync to db, "client" = local storage
	  config: true,       // false if you dont want it to show in module config
	  type: Number,       // Number, Boolean, String, Object
	  default: 10,
	  onChange: value => { // value is the new value of the setting
	  }
	});
	game.settings.register('swade-ws', 'maximum', {
	  name: 'Maximum Amount',
	  hint: 'Maximum cost allowed for a Wealth roll.',
	  scope: 'world',     // "world" = sync to db, "client" = local storage
	  config: true,       // false if you dont want it to show in module config
	  type: Number,       // Number, Boolean, String, Object
	  default: 1000000,
	  onChange: value => { // value is the new value of the setting
	  }
	});
	game.settings.register('swade-ws', 'adjustwait', {
	  name: 'Adjustment Period',
	  hint: "Time to wait between adjustments back to the base Wealth Die",
	  scope: 'world',     // "world" = sync to db, "client" = local storage
	  config: true,       // false if you dont want it to show in module config
	  type: String,       // Number, Boolean, String, Object
	  default: "a month",
	  onChange: value => { // value is the new value of the setting
	  }
	});
	game.settings.register('swade-ws', 'critfailwait', {
	  name: 'Critical Failure Wait',
	  hint: "Time to wait after critical failure.",
	  scope: 'world',     // "world" = sync to db, "client" = local storage
	  config: true,       // false if you dont want it to show in module config
	  type: String,       // Number, Boolean, String, Object
	  default: "a week",
	  onChange: value => { // value is the new value of the setting
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
	if (game.settings.get('swade-ws', 'rollwealth'))
		await game.SwadeWealth.buy(item, sheet);
});


function insertActorHeaderButtons(actorSheet, buttons) {
  let actor = actorSheet.object;
  if (actor.type != 'character' && actor.type != 'npc')
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
