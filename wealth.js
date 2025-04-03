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
	

	async buy(item, actor) {
		function isGranted(actor, item) {
			for (const it of actor.items) {
				const grants = it.getFlag('swade', 'hasGranted');
				if (grants) {
					return grants.includes(item._id);
				}
			}
			return false;
		}

		if (actor.type != 'character' && actor.type != 'npc')
			return;
		if (!item?.system?.price || item.system.price <= 0)
			return;
		if (isGranted(actor, item))
			return;

		await this.setBaseWealth(actor);
		
		if (actor.system.details.wealth.die <= 0) {
			const takeItAnyway = await Dialog.wait({
				title: `${actor.name} Is Broke`,
				content: `${actor.name} tried to buy ${item.name} and is <b>Broke</b>.`,
				buttons: {
					add: { label: "Buy Anyway", callback: (html) => (true) },
					dontAdd: { label: "Don't Buy", callback: () => (false) },
				},
				close: () => ( false )
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
		
		let rollMod = 0;
		let quantity = await Dialog.wait({
			title: `Wealth Roll for ${item.name}`,
			content: 
			`<p>Enter the quantity of ${item.name} (price: $${item.system.price}) to buy.</p>
			<p>The Wealth roll modifier for 1 ${item.name} at cost of ${item.system.price} is ${baseMod>0?'+':''}${baseMod}. Enter any additional modifier below for deals, rarity, etc.</p>
			<p>Click No Wealth Roll to buy ${item.name} without making a Wealth roll, or Cancel Purchase to completely cancel transaction.</p>
			<table>
				<tr>
					<td style="width: 20%">Quantity:</td>
					<td><input id="quantity" style="width: 60px" type="number" size="6" value="${item.system.quantity}"></input></td>
				</tr>
				<tr>
					<td style="width: 20%">Modifier:</td>
					<td><input id="modifier" style="width: 60px" type="number" size="6" value="0"></input></td>
				</tr>
			</table>`,
			buttons: {
				next: { label: "Wealth Roll", callback: (html) =>
					{
						rollMod = Number(html.find('#modifier').val());
						return Number(html.find('#quantity').val());
					}
				},
				noroll: { label: "No Wealth Roll", callback: () => (0) },
				remove: { label: "Cancel Purchase", callback: () => (null) },
			},
			close: () => ( 0 )
		});
		
		if (quantity <= 0 && quantity !== null)
			return;

		let totalCost = item.system.price * quantity;
		let itemName = quantity > 1 ? `${item.name} x ${quantity}` : item.name;

		let maxCost = game.settings.get('swade-ws', 'maximum');
		let maximum = maxCost.replaceAll(/wealth die/gi, wd);
		maximum = maximum.replaceAll(/wd/gi, wd);

		try {
			maximum = eval(maximum);
		} catch (msg) {
			ui.notifications.error(`There's an error in the Maximum Amount setting for the wealth system: (${maxCost})`);
			return;
		}
		if (totalCost > maximum) {
			ChatMessage.create({content: `The cost of ${itemName} ($${totalCost}) exceeds the maximum allowed for a Wealth roll ($${maxCost}).`});
			quantity = null;
		}

		if (quantity == null) {
			if (!item.isService)
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
		let brokewait = game.settings.get('swade-ws', 'brokewait');
		if (brokewait)
			brokewait = ` Declined to Go Broke. Must wait ${brokewait} before another Wealth roll.`;

		if (critFail) {
			const critfailwait = game.settings.get('swade-ws', 'critfailwait');
			content = `The Wealth roll was a <b>critical failure</b>! ${actor.name} cannot buy ${itemName}. No Wealth rolls for ${critfailwait}.`;
			deleteItem = true;
		} else if (roll.total < 4) {
			const buyItAnyway = await Dialog.wait({
				title: `Wealth Roll Failed`,
				content: `<p>The Wealth roll for ${item.name} <b>failed</b>: ${roll.total} = ${roll.result}.</p><br>`,
				buttons: {
					buy: { label: "Buy Anyway and Go Broke", callback: (html) => (true) },
					dontBuy: { label: "Don't Buy", callback: () => (false) },
				},
				close: () => ( false )
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
				const goBroke = await Dialog.confirm({
				  title: "Go Broke?",
				  content: `<p>Wealth roll succeeded: ${roll.total} = ${roll.result}, but Wealth Die is d4. Should ${actor.name} <b>go broke</b> for purchase?</p>
				  <p>Click Yes to Go Broke, No to cancel purchase.</p><br>`,
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
				const goBroke = await Dialog.confirm({
				  title: "Go Broke?",
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
			const goBroke = await Dialog.confirm({
			  title: "Go Broke?",
			  content: `<p>Wealth Support roll <b>failed</b>. Should ${actor.name} <b>go broke</b> to add 1 for Wealth Support roll?</p>`,
			  yes: (html) => { return true; },
			  no: (html) => { return false; }
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
		
		const action = await Dialog.wait({
			title: `Manage Wealth: ${actor.name}`,
			content: `<label style="font-size:14px;display:flex;align-items:center;margin-bottom: 5px;"></label>`,
			buttons: {
				service: {label: "Buy Service", callback: (html) => ('service')},
				reward: { label: "Add Reward", callback: (html) => ( 'reward' ) },
				adjust: { label: "Adjust Wealth", callback: (html) => ('adjust') },
				set: { label: "Set Base Wealth", callback: (html) => 
					{
						baseWealthDie = html.find('#base').val();
						return 'set';
					}
				},
				support: {label: "Support Roll", callback: () => ('support')},
				cancel: { label: "Cancel", callback: () => ('cancel') },
			},
			close: () => ( 'cancel' ),
			classes: 'horizontal-dialog'
		},{classes:["vertical-buttons"]});

		switch (action) {
		case 'reward':
			const reward = await Dialog.wait({
				title: `Reward: ${actor.name}`,
				content: `
				<p>Enter a value in Reward and click Add Reward. This will increase the Wealth die by the indicated number of die types (maximum of d12).</p>
					<table style="padding: 3px 3px 3px 3px">
						<tr>
							<td style="width: 20%">Reward:</td>
							<td><input id="reward" style="width: 60px" type="number" size="4" value="0"></input></td>
						</tr>
					</table>`,
				buttons: {
					next:
					{ label: "Add Reward", callback: (html) =>
						{
							return Number(html.find('#reward').val());
						}
					},
					cancel: {label: "Cancel", callback: () => (-1)},
				},
				close: () => ( -1 )
			});
			if (reward < 0)
				return;

			if (reward == 0) {
				ui.notifications.notify("Enter a value in Reward.");
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
			const baseWealthDie = await Dialog.wait({
				title: `Set Base Wealth: ${actor.name}`,
				content: `
				<p>To set the Base Wealth Die (the permanent value) enter a value in Base Wealth Die and click Set Base Wealth.</p>
					<table style="padding: 3px 3px 3px 3px">
						<tr>
							<td style="width: 40%">Base Wealth Die:</td>
							<td><input id="base" style="width: 60px" type="text" size="4" value=""></input></td>
						</tr>
					</table>`,
				buttons: {
					set: { label: "Set Base Wealth", callback: (html) => 
						{
							return html.find('#base').val();
						}
					},
					cancel: {label: "Cancel", callback: () => (-1)},
				},
				close: () => ( -1 )
			});

			if (baseWealthDie < 0)
				return;
		
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
		case 'service':
			Dialog.wait({
				title: `Pay for Service`,
				content: `
				<p>Enter the name of the service and the cost.</p>
					<table style="padding: 3px 3px 3px 3px">
						<tr>
							<td style="width: 30%">Service:</td>
							<td><input id="service" style="width: 300px" type="text" value=""></input></td>
						</tr>
						<tr>
							<td style="width: 20%">Service Cost:</td>
							<td><input id="cost" style="width: 60px" type="number" size="4" value="0"></input></td>
						</tr>
					</table>`,
				buttons: {
					set: { label: "Pay for Service", callback: (html) => 
						{
							let cost = Number(html.find('#cost').val());
							if (!cost || cost <= 0) {
								ui.notifications.notify('Enter the cost of the service in Service Cost.');
								return;
							}
							let service = html.find('#service').val();
							if (!service)
								service = "Service";
							let item = {name: service, isService: true, system: {price: cost, quantity: 1}};
							this.buy(item, actor);
						}
					},
					cancel: {label: "Cancel", callback: () => (-1)},
				},
				close: () => ( -1 )
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
		Dialog.wait({
			title: `Calculate Flight Time`,
			content: `<p>Calculate travel time, assuming accelerating to the half-way point, turning around and decelerating until destination reached. To go 100 ly in a day, for example, requires accleration = 400. Acceleration is expressed as units of distance per day (squared).</p>
			<table style="padding: 3px 3px 3px 3px">
				<tr>
					<td>Origin:</td>
					<td><input id="origin" style="width: 200px" type="text"></input></td>
				</tr>
				<tr>
					<td>Destination:</td>
					<td><input id="destination" style="width: 200px" type="text"></input></td>
				</tr>
				<tr>
					<td>Accleration:</td>
					<td><input id="a" style="width: 200px" type="number" value="400"></input></td>
				</tr>
				<tr>
					<td>Distance:</td>
					<td><input id="s" style="width: 200px" type="text" value=""></input></td>
				</tr>
			</table>`,
			buttons: {
				ok: { label: "OK", callback: (html) =>
					{
						const a = Number(html.find('#a').val());
						const s = html.find('#s').val();
						const origin = html.find('#origin').val();
						const destination = html.find('#destination').val();
						const distance = s.replaceAll(/[^0-9]+/g, '');
						let t = 2 * Math.sqrt(Number(distance) / a);
						let units = 'day(s)';
						if (t < 1) {
							t = Math.round(t * 24);
							units = 'hour(s)';
						} else
							t = Math.round(t);
						ChatMessage.create({content: `Travel time ${origin?origin:'origin'} to ${destination?destination:'destination'}, distance ${s}: ${t} ${units} (a = ${a}).`});
						return 1;
					}
				},
				cancel: { label: "Cancel", callback: () => (0) },
			},
			close: () => ( 0 )
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
	if (data != game.user.id || !item.parent)
		return;
	if (game.settings.get('swade-ws', 'rollwealth'))
		await game.SwadeWealth.buy(item, sheet.parent);
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
