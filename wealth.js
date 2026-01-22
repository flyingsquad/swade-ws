/**	Perform standard point buy method for character abilities.
 */
 
export class Wealth {
	actor = null;
	dlg = null;
	wealthDie = null;
	purchaseTable = [];
	itemPileTransfer = [];

	async setBaseWealth(actor) {
		if (actor.getFlag('swade-ws', 'baseWealth'))
			return;
		await actor.setFlag('swade-ws', 'baseWealth', actor.system.details.wealth.die);
	}


	async buy(item, actor) {
		if (actor.type != 'character' && actor.type != 'npc')
			return;
		if (!item?.system?.price || item.system.price <= 0)
			return;

		await this.setBaseWealth(actor);
		
		if (actor.system.details.wealth.die <= 0) {
			const takeItAnyway = await foundry.applications.api.DialogV2.wait({
				window: {title: `${actor.name} Is Broke`},
				content: `${actor.name} tried to buy ${item.name} and is Broke.`,
				buttons: [
					{
						action: "add",
						label: "Buy Anyway",
						callback: () => (true) 
					},
					{
						action: "dontAdd",
						label: "Don't Buy",
						callback: () => (false)
					}
				]
			});
			if (!takeItAnyway) {
				if (!item.isService)
					actor.deleteEmbeddedDocuments("Item", [item._id]);
			} else {
				ChatMessage.create({content: `${actor.name} is <b>broke</b> and bought ${item.name} anyway.`});
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

		let baseMod = 0;
		for (let i = 0; i < this.purchaseTable.length; i++) {
			baseMod = this.purchaseTable[i].modifier;
			if (item.system.price <= this.purchaseTable[i].cost)
				break;
		}

		// Get the quantity of items bought from the player and whether
		// the item should be charged at all.
		
		let content = `<div style="500px">
			<p>Enter the quantity of ${item.name} (price: $${item.system.price}) to buy.</p>
			<p>The Wealth roll modifier for 1 ${item.name} at cost of ${item.system.price} is ${baseMod>0?'+':''}${baseMod}. Enter any additional modifier below for deals, rarity, etc.</p>
			<p>Click No Wealth Roll to buy ${item.name} without making a Wealth roll, or Cancel Purchase to completely cancel transaction.</p>
			<p>
				<label>Quantity:
					<input name="quantity" style="width: 60px" type="number" size="6" value="${item.system.quantity}" autofocus></input>
				</label>
			</p>
			<p>
				<label>Modifier:
					<input name="modifier" style="width: 60px" type="number" size="6" value="0"></input>
				</label>
			</p>
			</div>`;
		const arg = {
			window: {title: `Wealth Roll for ${item.name}` },
			content: content,
			buttons: [
				{
					action: "next",
					label: "Wealth Roll",
					default: true,
					callback: (event, button, dialog) =>
						{
							const rollMod = button.form.elements.modifier.valueAsNumber;
							const quantity = button.form.elements.quantity.valueAsNumber;
							buyIt(this, quantity, rollMod);
						}
				},
				{
					action: "noroll",
					label: "No Wealth Roll",
					callback: () => {
						ChatMessage.create({content: `${actor.name} added ${item.name} without a Wealth Die roll.`});
						return;
					}
				},
				{
					action: "remove",
					label: "Cancel Purchase", callback: async () => {
						ChatMessage.create({content: `${actor.name} cancelled ${item.name} purchase.`});
						await actor.deleteEmbeddedDocuments("Item", [item._id]);
					}
				}
			]
		};
		
		await new foundry.applications.api.DialogV2(arg).render({force: true});

		async function buyIt(ws, quantity, rollMod) {

			let totalCost = item.system.price * quantity;
			let itemName = quantity > 1 ? `${item.name} x ${quantity}` : item.name;

			let maxCost = game.settings.get('swade-ws', 'maximum');
			let maximum = maxCost.replaceAll(/wealth die/gi, wd);
			maximum = maximum.replaceAll(/wd/gi, wd);
			maximum = maximum.replaceAll(/[A-Za-z]/g, '');

			try {
				maximum = eval(maximum);
			} catch (msg) {
				ui.notifications.error(`There's an error in the Maximum Amount setting for the wealth system: (${maxCost})`);
				return;
			}
			if (totalCost > maximum) {
				ChatMessage.create({content: `The cost of ${itemName} ($${totalCost}) exceeds the maximum allowed for a Wealth roll: $${maximum} (${maxCost}).`});
				quantity = null;
			}

			if (quantity == null) {
				if (!item.isService)
					actor.deleteEmbeddedDocuments("Item", [item._id]);
				return;
			}

			// Exit if cost is below the wealth threshhold.
			if (totalCost < incidentals) {
				// If actor has racked up enough minor purchases check for this one.
				let minorPurchases = actor.getFlag('swade-ws', 'minor');
				if (!minorPurchases)
					minorPurchases = 0;
				minorPurchases += totalCost;
				if (minorPurchases < incidentals) {
					actor.setFlag('swade-ws', 'minor', minorPurchases);
					ChatMessage.create({content: `The purchase of ${item.name} ($${totalCost}) is not large enough to warrant a Wealth Die roll.`});
					return;
				}
				actor.setFlag('swade-ws', 'minor', 0);
			}

			let modifier = 0;
			for (let i = 0; i < ws.purchaseTable.length; i++) {
				modifier = ws.purchaseTable[i].modifier;
				if (totalCost <= ws.purchaseTable[i].cost)
					break;
			}

			modifier += rollMod;

			let done = false;
			let roll;
			let critFail;
			let rollSpec = `{1d${wd}x[Wealth Die],1d${actor.system.details.wealth['wild-die']}x[Wild Die]}kh + ${actor.system.details.wealth.modifier}[Wealth Modifier] + ${modifier}[Cost Modifier]`;
			let rollMsg;

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

				const text = `<b>${outcome}:</b> Wealth Roll to purchase ${itemName}.`;
				rollMsg = await roll.toMessage({flavor: text}, {flavor: text});

				if (roll.total >= 8 || actor.system.bennies.value <= 0)
					break;

				outcome = await foundry.applications.api.DialogV2.wait({
					window: { title: `Wealth Roll Result for ${item.name}` },
					content: `<div style="width: 400px">
							<p>${res}</p>
							<p>&nbsp;&nbsp;&nbsp;Result: ${roll.total} = ${roll.result}</p>
							<p>Bennies: ${actor.system.bennies.value}</p>
						</div>`,
					buttons: [
						{
							action: "ok",
							label: "Use Roll",
							callback: (event, button, dialog) => 1
						},
						{
							action: "reroll",
							label: "Spend Benny to Reroll",
							callback: () => (0) 
						}
					]
				});
				
				if (outcome == null) {
					// Clicked dialog close box.
					ChatMessage.create({content: `${actor.name} cancelled purchase of ${item.name}.`});
					await actor.deleteEmbeddedDocuments("Item", [item._id]);
					return;
				}
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
			let brokewait = game.settings.get('swade-ws', 'brokewait');
			if (brokewait)
				brokewait = ` Declined to Go Broke. Must wait ${brokewait} before another Wealth roll.`;

			if (critFail) {
				const critfailwait = game.settings.get('swade-ws', 'critfailwait');
				content = `The Wealth roll was a <b>critical failure</b>! ${actor.name} cannot buy ${itemName}. No Wealth rolls for ${critfailwait}.`;
				deleteItem = true;
			} else if (roll.total < 4) {
				const buyItAnyway = await foundry.applications.api.DialogV2.wait({
					window: { title: `Wealth Roll Failed` },
					content:
						`<div style="width: 500px">
							<p>The Wealth roll for ${item.name} <b>failed</b>: ${roll.total} = ${roll.result}.</p>
						</div>`,
					buttons: [
						{
							action: "buy",
							label: "Buy Anyway and Go Broke",
							callback: (event, button, dialog) => true
						},
						{
							action: "dontBuy",
							label: "Don't Buy",
							callback: () => (false) 
						}
					]
				});

				if (buyItAnyway) {
					content = `${actor.name} bought ${itemName}. Wealth roll <b>failed</b>: ${actor.name} <b>went broke</b>.`;
					await actor.update({[`system.details.wealth.die`]: 0});
				} else {
					content = `${actor.name} did not buy ${itemName}. Wealth roll <b>failed</b>.` + brokewait;
					deleteItem = true;
				}
			} else if (roll.total < 8) {
				if (wd <= 4) {
					const goBroke = await foundry.applications.api.DialogV2.confirm({
					  window: {title: "Go Broke?"},
					  content: `<div style="width: 500px">
						<p>Wealth roll succeeded: ${roll.total} = ${roll.result}, but Wealth Die is d4. Should ${actor.name} <b>go broke</b> for purchase?</p>
						<p>Click Yes to Go Broke, No to cancel purchase.</p><br>
						</div>`,
					  yes: (html) => { return true; },
					  no: (html) => { return false; }
					});
					if (!goBroke) {
						if (!item.isService)
							deleteItem = true;
						content = `Wealth roll <b>succeeded</b>, but purchase cancelled  ${itemName} purchase of because Wealth die is d4 and ${actor.name} would <b>go broke</b>.` + brokewait;
					} else {
						content = `${actor.name} bought ${itemName}. Wealth roll <b>succeeded</b>: ${actor.name} <b>went broke</b> (Wealth die was d4).`;
						wd = 0;
					}
				} else {
					wd -= 2;
					content = `${actor.name} bought ${itemName}. Wealth roll <b>succeeded</b>: Wealth die decreased to d${wd}.`;
				}
				await actor.update({[`system.details.wealth.die`]: wd});
			} else {
				ui.notifications.notify('Wealth Roll was a raise!');
				content = `${actor.name} bought ${itemName}. Wealth roll was a <b>raise</b>: Wealth die unchanged.`;
			}

			if (deleteItem) {
				if (!item.isService)
					await actor.deleteEmbeddedDocuments("Item", [item._id]);
			} else {
				// Make sure the quantity is right.
				if (quantity != item.system.quantity) {
					if (!item.isService)
						await actor.updateEmbeddedDocuments("Item", [{ "_id": item._id, ['system.quantity']: quantity }]);
				}
			}
			rollMsg.update({flavor: `<span style="font-size: 14px; color: black">${content}</span>`});
			ui.chat.scrollBottom();
		}
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
		let rollMsg;
		let critFail;
		let rollSpec = `{1d${wd}x[Wealth Die],1d${actor.system.details.wealth['wild-die']}x[Wild Die]}kh + ${actor.system.details.wealth.modifier}[Wealth Modifier]`;

		while (!done) {
			roll = new Roll(rollSpec);
			await roll.evaluate();
			const text = `Wealth Roll to support another character's Wealth roll.`;
			rollMsg = await roll.toMessage({flavor: text}, {flavor: text});

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
				res = 'Failure: Go Broke to Support or offer no Support.';
			
			const outcome = await foundry.applications.api.DialogV2.wait({
				window: {title: `Support Wealth Roll Result`},
				content: `<p>${res}</br>&nbsp;&nbsp;&nbsp;Result: ${roll.total} = ${roll.result}</br>Bennies: ${actor.system.bennies.value}</p>`,
				buttons: [
					{
						action: "next",
						label: "Use Roll",
						callback: () => (1) 
					},
					{
						action: "reroll",
						label: "Spend Benny to Reroll",
						callback: () => (0)
					}
				]
			});		
			if (outcome == -1 || outcome == null)
				return;
			if (outcome == 1)
				done = true;
			else {
				await actor.update({[`system.bennies.value`]: actor.system.bennies.value - 1});
				ChatMessage.create({content: `${actor.name} spent Benny to support Wealth roll.`});
			}
		}

		let content;
		let add1 = true;
		const oldWD = wd;
		let brokeWait = game.settings.get('swade-ws', 'brokewait');
		if (brokeWait)
			brokeWait = ` Declined to Go Broke. Must wait ${brokeWait} before another Wealth roll.`;

		if (critFail) {
			content = `${actor.name}: Wealth Support roll was a <b>critical failure</b>. Must wait ${game.settings.get('swade-ws', 'critfailwait')} to try again.`;
			add1 = false;
		} else if (roll.total >= 8) {
			content = `${actor.name} <b>succeeded</b> Wealth Support roll with a <b>raise</b>.`;
		} else if (roll.total >= 4) {
			if (wd <= 4) {
				const goBroke = await foundry.applications.api.DialogV2.confirm({
				  window: {title: "Go Broke?"},
				  content: `<p>Wealth Support roll succeeded: ${roll.total} = ${roll.result}, but Wealth Die is d4. Should ${actor.name} <b>go broke</b> for Wealth Support roll?</p>`,
				  yes: (html) => { return true; },
				  no: (html) => { return false; }
				});
				if (!goBroke) {
					content = `Wealth Support cancelled to avoid going broke.` + brokeWait;
					add1 = false;
				} else {
					wd = 0;
					content = `${actor.name}: Wealth Support roll <b>succeeded</b>, but <b>went broke</b>.`;
				}
			} else {
				wd -= 2;
				content = `${actor.name}: Wealth Support roll <b>succeeded</b>. Wealth die reduced to d${wd}.`;
			}
		} else {
			const goBroke = await foundry.applications.api.DialogV2.confirm({
			  window: {title: "Go Broke?"},
			  content: `<p>Wealth Support roll <b>failed</b>. Should ${actor.name} <b>go broke</b> to add 1 for Wealth Support roll?</p>`,
			  yes: () => { return true; },
			  no: () => { return false; }
			});
			if (!goBroke) {
				content = `Wealth Support cancelled to avoid going broke.` + brokeWait;
				add1 = false;
			} else {
				wd = 0;
				content = `${actor.name}: Wealth Support roll <b>failed</b> and <b>went broke</b>.`;
			}
		}

		if (add1)
			 content += ` Add 1 to other character's Wealth roll.`;
		rollMsg.update({flavor: `<span style="font-size: 14px; color: black">${content}</span>`});
		ui.chat.scrollBottom();

		if (wd != oldWD)
			await actor.update({[`system.details.wealth.die`]: wd});
	}

	
	async manage(actor) {
		await this.setBaseWealth(actor);
		let reward = 0;
		let baseWealthDie = "";

		let bwd = actor.getFlag('swade-ws', 'baseWealth');
		let wd = actor.system.details.wealth.die;
		let dispWd = wd < 4 ? 'Broke' : 'd' + wd;
		
		const content = `
			<p>Current Wealth Die: ${dispWd}.</p>
			<label><input type="radio" name="choice" value="service" checked> Service</label>
			<label><input type="radio" name="choice" value="reward"> Add Reward</label>
			<label><input type="radio" name="choice" value="adjust"> Adjust Wealth Over Time</label>
			<label><input type="radio" name="choice" value="set"> Set Base Wealth</label>
			<label><input type="radio" name="choice" value="support"> Support Roll</label>
			`;
		const action = await foundry.applications.api.DialogV2.wait({
			window: {title: `Manage Wealth: ${actor.name}`},
			content: content,
			buttons: [
				{
					action: "ok",
					label: "Next",
					callback: (event, button, dialog) => (button.form.elements.choice.value)
				},
				{
					action: "cancel",
					label: "Cancel",
					callback: (html) => ( 'cancel' )
				}
			]
		});

		switch (action) {
		case 'reward':
			const reward = await foundry.applications.api.DialogV2.wait({
				window: {
					title: `Reward: ${actor.name}`,
					position: {
						width: 400
					}
				},
				content: `
				<p>Enter a value in Reward and click Add Reward.</br>This will increase the Wealth die by the indicated number of die types (maximum of d12).</p>
							<label>Reward:
							<input name="reward" style="width: 60px" type="number" size="4" value="1" autofocus></input>
							</label>
					`,
				buttons:
				[
					{
						action: "next",
						label: "Add Reward",
						callback: (event, button, dialog) =>
						{
							return button.form.elements.reward.valueAsNumber;
						}
					},
					{
						action: "cancel",
						label: "Cancel",
						callback: () => (-1)
					}
				]
			});
			if (reward < 0 || reward == null)
				return;

			if (reward == 0) {
				ui.notifications.notify("Enter a numerical value in Reward.");
				return;
			}
			this.reward(actor, reward);
			ChatMessage.create({content: `${actor.name} received ${reward} reward(s).`});
			break;
		case 'adjust':
			await this.adjust(actor);
			if (actor.system.details.wealth.die != wd)
				ChatMessage.create({content: `Adjusted ${actor.name}'s wealth die to d${actor.system.details.wealth.die} for the passage of time.`});
			else
				ui.notifications.notify(`${actor.name}'s Wealth Die unchanged at d${wd}.`);
			break;
		case 'set':
			let baseWealthDie;
			const result = await foundry.applications.api.DialogV2.wait({
				title: `Set Base Wealth: ${actor.name}`,
				content: `
				<p>You are setting the Base Wealth Die, the value that is</br>returned to over the passage of time.</br></br>Select a value and click Set Base Wealth.</p>
					<label><input type="radio" name="base" value="0"  ${wd==0?'checked':''}> Broke</label>
					<label><input type="radio" name="base" value="4"  ${wd==4?'checked':''}> d4</label>
					<label><input type="radio" name="base" value="6"  ${wd==6?'checked':''}> d6</label>
					<label><input type="radio" name="base" value="8"  ${wd==8?'checked':''}> d8</label>
					<label><input type="radio" name="base" value="10"  ${wd==10?'checked':''}> d10</label>
					<label><input type="radio" name="base" value="12"  ${wd==12?'checked':''}> d12</label>
				`,
				buttons: [
					{
						action: "set",
						label: "Set Base Wealth",
						callback: (event, button, dialog) => {
							baseWealthDie = Number(button.form.elements.base.value);
						}
					},
					{
						action: "cancel",
						label: "Cancel",
						callback: () => (-1)
					}
				]
			});

			if (result == 'cancel' || result == null)
				return;
		
			switch (baseWealthDie) {
			case 0: case 4: case 6: case 8: case 10: case 12:
				await actor.update({[`system.details.wealth.die`]: baseWealthDie});
				await actor.setFlag('swade-ws', 'baseWealth', baseWealthDie);
				let msg = `Set ${actor.name}'s wealth die to d${baseWealthDie}.`
				if (baseWealthDie == 0)
					msg = `Set ${actor.name}'s wealth die to Broke.`;
				ui.notifications.notify(msg);
				ChatMessage.create({content: msg});
				break;
			default:
				ui.notifications.notify("Base Wealth Die must be d4, d6, d8, d10 or d12.");
				break;
			}
			break;
		case 'support':
			this.wealthSupport(actor);
			break;
		case 'service':
			foundry.applications.api.DialogV2.wait({
				window: {
					title: `Pay for Service`
				},
				content: `
					<div style="width: 500px">
					<p>Enter the name of the service and the cost.</p>
					<label style="width: 100px">Service:
						<input name="service" style="width: 200px" type="text" value="Service" autofocus></input>
					</label>
					</p>
					<p>
					<label style="width: 100px">Service Cost:
						<input name="cost" style="width: 60px" type="number" size="5" value="0"></input>
					</label>
					</p>
					</div>
				`,
				buttons: [
					{
						action: "set",
						label: "Pay for Service",
						callback: (event, button, dialog) => {
							let cost = button.form.elements.cost.valueAsNumber;
							if (!cost || cost <= 0) {
								ui.notifications.notify('Enter the cost of the service in Service Cost.');
								return;
							}
							let service = button.form.elements.service.value;
							if (!service)
								service = "Service";
							let item = {name: service, isService: true, system: {price: cost, quantity: 1}};
							this.buy(item, actor);
						}
					},
					{
						action: "cancel",
						label: "Cancel",
						callback: () => (-1)
					}
				]
			});
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

	travelTime() {
		foundry.applications.api.DialogV2.wait({
			window: {title: `Calculate Flight Time`},
			content: `
			<div style="width:500px">
			<p>Calculate travel time, assuming accelerating to the half-way point, turning around and decelerating until destination reached. To go 100 ly in a day, for example, requires accleration = 400. Acceleration is expressed as units of distance per day (squared).</p>
			<table style="padding: 3px 3px 3px 3px">
				<tr>
					<td>Origin:</td>
					<td><input name="origin" style="width: 200px" type="text"></input></td>
				</tr>
				<tr>
					<td>Destination:</td>
					<td><input name="destination" style="width: 200px" type="text"></input></td>
				</tr>
				<tr>
					<td>Accleration:</td>
					<td><input name="a" style="width: 200px" type="number" value="400"></input></td>
				</tr>
				<tr>
					<td>Distance:</td>
					<td><input name="s" style="width: 200px" type="number" value=""></input></td>
				</tr>
			</table>
			</div>`,
			buttons: [
				{
					action: "ok",
					label: "OK",
					callback: (event, button, dialog) => {
						const a = button.form.elements.a.valueAsNumber;
						const distance = button.form.elements.s.valueAsNumber;
						const origin = button.form.elements.origin.value;
						const destination = button.form.elements.destination.value;

						let t = 2 * Math.sqrt(distance / a);
						let units = 'day(s)';
						if (t < 1) {
							t = Math.round(t * 24);
							units = 'hour(s)';
						} else
							t = Math.round(t);
						ChatMessage.create({content: `Travel time ${origin?origin:'origin'} to ${destination?destination:'destination'}, distance ${distance}: ${t} ${units} (a = ${a}).`});
						return 1;
					}
				},
				{
					action: "cancel",
					label: "Cancel",
					callback: () => (0)
				}
			]
		});
	}

	async setTokenImage() {
		if (canvas.tokens.controlled.length != 1) {
			ui.notifications.notify('Select one token.');
			return;
		}

		let token = canvas.tokens.controlled[0];
		let actor = game.actors.get(token.document.actorId);

		const portraitFolder = "/";
		let tokenPicker = new FilePicker({
			type: "image",
			displayMode: "tiles",
			current: portraitFolder,
			callback: (file) => {
				token.document.update({
					"ring.enabled": false,
					"ring.subject.texture": "",
					"texture.src": file, 
					"texture.scaleX": 0.8, 
					"texture.scaleY": 0.8, 
					"bar1.attribute": "wounds",
					"bar2.attribute": "fatigue",
					"displayBars": 30,
					"displayName": 30
				});

				actor.update({
					"img": file,
					"prototypeToken.ring.enabled": false,
					"prototypeToken.ring.subject.texture": "",
					"prototypeToken.texture.src": file, 
					"prototypeToken.texture.scaleX": 0.8, 
					"prototypeToken.texture.scaleY": 0.8, 
					"prototypeToken.bar1.attribute": "wounds",
					"prototypeToken.bar2.attribute": "fatigue",
					"prototypeToken.displayBars": 30,
					"displayName": 30
				});
			},
			close: () => {return null}
		});
		tokenPicker.render();
	}

	async rewardTokens() {
		const reward = await foundry.applications.api.DialogV2.wait({
			window: {title: `Wealth Reward`},
			content: `
				<div style="width: 300px">
					<label>Reward to grant:
						<input name="reward" style="width: 30px" type="number" size="2" value="1" autofocus></input>
					</label>
				</div>`,
			buttons: [
				{
					action: "next",
					label: "Grant Reward",
					callback: (event, button, dialog) => (button.form.elements.reward.valueAsNumber)
				},
				{
					action: "remove",
					label: "Cancel",
					callback: () => (0)
				}
			]
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
	game.settings.register('swade-ws', 'npcs', {
	  name: 'NPC Wealth Rolls',
	  hint: 'Make Wealth rolls for NPCs.',
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
	  default: "500:+1, 1000:0, 2000:-1, 4000:-2, 8000:-3, 16000:-4, 32000:-5, 64000:-6, 128000:-7",
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
	  hint: 'Maximum cost allowed for a Wealth roll: a number or expression of the form "Wealth Die * 10000"',
	  scope: 'world',     // "world" = sync to db, "client" = local storage
	  config: true,       // false if you dont want it to show in module config
	  type: String,       // Number, Boolean, String, Object
	  default: "Wealth Die * 10000",
	  onChange: value => { // value is the new value of the setting
	  }
	});
	game.settings.register('swade-ws', 'adjustwait', {
	  name: 'Adjustment Period',
	  hint: "Time to wait between adjustments back to the base Wealth Die.",
	  scope: 'world',     // "world" = sync to db, "client" = local storage
	  config: true,       // false if you dont want it to show in module config
	  type: String,       // Number, Boolean, String, Object
	  default: "a month",
	  onChange: value => { // value is the new value of the setting
	  }
	});
	game.settings.register('swade-ws', 'brokewait', {
	  name: 'Broke Wait',
	  hint: "Time to wait before making another Wealth Roll after declining to go broke.",
	  scope: 'world',     // "world" = sync to db, "client" = local storage
	  config: true,       // false if you dont want it to show in module config
	  type: String,       // Number, Boolean, String, Object
	  default: "a week",
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
	if (data != game.user.id || !item.parent || sheet.isItemGrant)
		return;
	// Exit if this was the result of a player getting an item from a pile.
	const index = game.SwadeWealth.itemPileTransfer.indexOf(sheet.parent._id);
	if (index > -1) {
		game.SwadeWealth.itemPileTransfer.splice(index, 1);
		return;
	}
	if (game.settings.get('swade-ws', 'rollwealth')) {
		if (sheet.parent.type == 'npc' && !game.settings.get('swade-ws', 'npcs'))
			return;
		await game.SwadeWealth.buy(item, sheet.parent);
	}
});


Hooks.on("item-piles-preTransferItems", async function(srcActor, srcItem, dstActor, dstItem, data) {
	// Record the actor id of the recipient so we can ignore the createItem hook
	// to avoid having the wealth dialog pop up on the GM screen.
	game.SwadeWealth.itemPileTransfer.push(dstActor._id);
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
