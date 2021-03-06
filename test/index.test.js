const { ethers } = require('hardhat')
const { BigNumber } = require('ethers')
const assert = require('assert')
const {
  getChannelId,
  getFixedPart,
  getVariablePart,
  signState,
  signStates,
  convertAddressToBytes32,
  Transactions,
  hashAppPart,
  encodeOutcome,
  signChallengeMessage,
  hashState,
} = require('@statechannels/nitro-protocol')

function createOutcome(balances, adjudicator) {
  const allocation = balances.map(({ address, amount }) => {
    return {
      destination: ethers.utils.hexZeroPad(address, 32),
      amount: (typeof amount === 'object' && amount) ? amount.toHexString() : amount,
    }
  })
  return [
    {
      asset: ethers.constants.AddressZero,
      assetHolderAddress: adjudicator.address,
      allocationItems: allocation,
    }
  ]
}

// Have each deposit enough to
async function createIntermediaryChannel(irene, other, adjudicator, app) {
  const channel = {
    chainId: '0x1234',
    channelNonce: BigNumber.from(0).toHexString(),
    participants: [irene.address, other.address],
  }
  const depositAmount = BigNumber.from(1000).toHexString()
  const startingOutcome = createOutcome([
    {
      address: irene.address,
      amount: depositAmount,
    },
    {
      address: other.address,
      amount: depositAmount,
    }
  ], adjudicator)
  const baseState = {
    isFinal: false,
    channel,
    outcome: startingOutcome,
    appDefinition: app.address,
    appData: ethers.constants.HashZero,
    challengeDuration: 1,
  }
  const state0 = {
    ...baseState,
    turnNum: 0,
  }
  const state1 = {
    ...baseState,
    turnNum: 1,
  }
  const whoSignedWhat = [0,1]
  const preFundSigs = await signStates([state0, state1], [irene, other], whoSignedWhat)
  const channelId = getChannelId(channel)
  const ireneDepositTx = await adjudicator.connect(irene).deposit(
    '0x0000000000000000000000000000000000000000',
    channelId,
    0,
    depositAmount,
    {
      value: depositAmount,
    }
  )
  await ireneDepositTx.wait()
  const otherDepositTx = await adjudicator.connect(other).deposit(
    '0x0000000000000000000000000000000000000000',
    channelId,
    depositAmount,
    depositAmount,
    {
      value: depositAmount,
    }
  )
  await otherDepositTx.wait()
  return { channelId, channel, outcome: startingOutcome }
}

describe('Virtual Funding', function () {
  it('should non-cooperatively defund a virtual channel', async () => {
    const NitroAdjudicator = await ethers.getContractFactory('NitroAdjudicator')
    const adjudicator = await NitroAdjudicator.deploy()
    await adjudicator.deployed()

    const ForceMoveApp = await ethers.getContractFactory('ForceMoveApp')
    const app = await ForceMoveApp.deploy()
    await app.deployed()

    const [ funding ] = await ethers.getSigners()
    const [ irene, bob, alice ] = [
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
    ].map(wallet => wallet.connect(funding.provider))
    for (const wallet of [irene, bob, alice]) {
      const tx = await funding.sendTransaction({
        to: wallet.address,
        value: ethers.utils.parseEther('1'),
      })
      await tx.wait()
    }

    const {
      channelId: bobChannelId,
      channel: bobChannel,
      outcome: bobOutcome
    } = await createIntermediaryChannel(irene, bob, adjudicator, app)
    const {
      channelId: aliceChannelId,
      channel: aliceChannel,
      outcome: aliceOutcome,
    } = await createIntermediaryChannel(irene, alice, adjudicator, app)

    // now create a 3 person channel. Irene will need to consent to this

    const interChannel = {
      chainId: '0x1234',
      channelNonce: BigNumber.from(0).toHexString(),
      participants: [irene.address, bob.address, alice.address],
    }

    let interSigs = []
    let interStates = []

    const depositAmount = BigNumber.from(100)
    const startingOutcome = createOutcome([
      {
        address: irene.address,
        amount: depositAmount.mul(2),
      },
      {
        address: bob.address,
        amount: depositAmount,
      },
      {
        address: alice.address,
        amount: depositAmount,
      },
    ], adjudicator)
    const baseState = {
      isFinal: false,
      channel: interChannel,
      outcome: startingOutcome,
      appDefinition: app.address,
      appData: ethers.constants.HashZero,
      challengeDuration: 1,
    }
    const interChannelId = getChannelId(interChannel)
    let whoSignedWhat = [0,1,2]
    interSigs = await signStates([
      {
        ...baseState,
        turnNum: 0,
      },
      {
        ...baseState,
        turnNum: 1,
      },
      {
        ...baseState,
        turnNum: 2,
      }
    ], [irene, bob, alice], whoSignedWhat)
    // now all three have agreed to the inter channel
    // now convince Irene to fund this channel
    // any new outcome that doesn't jeopardise her funds should be fine

    // just the latest two
    let ireneBobSigs = []
    let ireneBobStates = []
    let ireneAliceSigs = []
    let ireneAliceStates = []

    const baseDepositAmount = BigNumber.from(1000)
    {
      // update bob channel state
      // bob and alice need to deposit or in order of payment priority for
      // guarantor claims
      const state = {
        isFinal: false,
        channel: bobChannel,
        outcome: createOutcome([
          {
            address: irene.address,
            amount: baseDepositAmount.sub(depositAmount),
          },
          {
            address: bob.address,
            amount: baseDepositAmount.sub(depositAmount),
          },
          {
            address: interChannelId,
            amount: depositAmount.mul(2),
          }
        ], adjudicator),
        appDefinition: app.address,
        appData: ethers.constants.HashZero,
        challengeDuration: 1,
      }
      const state0 = {
        ...state,
        turnNum: 2,
      }
      const state1 = {
        ...state,
        turnNum: 3,
      }
      ireneBobStates = [state0, state1]
      whoSignedWhat = [0,1]
      ireneBobSigs = await signStates(ireneBobStates, [irene, bob], whoSignedWhat)
    }
    {
      const state = {
        isFinal: false,
        channel: aliceChannel,
        outcome: createOutcome([
          {
            address: irene.address,
            amount: baseDepositAmount.sub(depositAmount),
          },
          {
            address: alice.address,
            amount: baseDepositAmount.sub(depositAmount),
          },
          {
            address: interChannelId,
            amount: depositAmount.mul(2),
          }
        ], adjudicator),
        appDefinition: app.address,
        appData: ethers.constants.HashZero,
        challengeDuration: 1,
      }
      const state0 = {
        ...state,
        turnNum: 2,
      }
      const state1 = {
        ...state,
        turnNum: 3,
      }
      ireneAliceStates = [state0, state1]
      whoSignedWhat = [0,1]
      ireneAliceSigs = await signStates(ireneAliceStates, [irene, alice], whoSignedWhat)
    }
    // now the inter channel is funded
    // we need a channel just for bob and alice
    const bobAliceChannel = {
      chainId: '0x1234',
      channelNonce: BigNumber.from(0).toHexString(),
      participants: [bob.address, alice.address],
    }
    const bobAliceChannelId = getChannelId(bobAliceChannel)
    const bobAliceOutcome = createOutcome([
      {
        address: bob.address,
        amount: depositAmount,
      },
      {
        address: alice.address,
        amount: depositAmount,
      }
    ], adjudicator)
    const bobAliceState = {
      isFinal: false,
      channel: bobAliceChannel,
      outcome: bobAliceOutcome,
      appDefinition: app.address,
      appData: ethers.constants.HashZero,
      challengeDuration: 1,
    }
    whoSignedWhat = [0,1]
    let bobAliceSigs = await signStates([
      {
        ...bobAliceState,
        turnNum: 0,
      },
      {
        ...bobAliceState,
        turnNum: 1,
      },
    ], [bob, alice], whoSignedWhat)

    // new we set the inter channel to fund the bob alice channel
    const interNextOutcome = createOutcome([
      {
        address: irene.address,
        amount: depositAmount.mul(2),
      },
      {
        address: bob.address,
        amount: BigNumber.from(0),
      },
      {
        address: alice.address,
        amount: BigNumber.from(0),
      },
      {
        address: bobAliceChannelId,
        amount: depositAmount.mul(2),
      },
    ], adjudicator)
    const interNextState = {
      isFinal: false,
      channel: interChannel,
      outcome: interNextOutcome,
      appDefinition: app.address,
      appData: ethers.constants.HashZero,
      challengeDuration: 1,
    }
    whoSignedWhat = [0,1,2]
    interStates = [
      {
        ...interNextState,
        turnNum: 3,
      },
      {
        ...interNextState,
        turnNum: 4,
      },
      {
        ...interNextState,
        turnNum: 5,
      }
    ]
    interSigs = await signStates(interStates, [irene, bob, alice], whoSignedWhat)

    // now the bob-alice channel is funded
    const aliceInterPay = depositAmount.mul(2).sub(10)
    const bobInterPay = BigNumber.from(10)

    const bobAliceNextOutcome = createOutcome([
      {
        address: bob.address,
        amount: bobInterPay,
      },
      {
        address: alice.address,
        amount: aliceInterPay,
      }
    ], adjudicator)
    const bobAliceNextState = {
      isFinal: false,
      channel: bobAliceChannel,
      outcome: bobAliceNextOutcome,
      appDefinition: app.address,
      appData: ethers.constants.HashZero,
      challengeDuration: 1,
    }
    whoSignedWhat = [0,1]
    const bobAliceStates = [
      {
        ...bobAliceNextState,
        turnNum: 2,
      },
      {
        ...bobAliceNextState,
        turnNum: 3,
      },
    ]
    bobAliceSigs = await signStates(bobAliceStates, [bob, alice], whoSignedWhat)

    // now assume all refuse to send more signatures
    // start by creating challenges in the ledger channels
    const bobChallengeTx = await adjudicator.connect(funding).challenge(
      getFixedPart(ireneBobStates[1]),
      ireneBobStates[1].turnNum,
      ireneBobStates.map(state => getVariablePart(state)),
      0,
      ireneBobSigs,
      [0, 1],
      signChallengeMessage(
        [signState(ireneBobStates[1], bob.privateKey)],
        bob.privateKey
      )
    )
    await bobChallengeTx.wait()

    const aliceChallengeTx = await adjudicator.connect(funding).challenge(
      getFixedPart(ireneAliceStates[1]),
      ireneAliceStates[1].turnNum,
      ireneAliceStates.map(state => getVariablePart(state)),
      0,
      ireneAliceSigs,
      [0, 1],
      signChallengeMessage(
        [signState(ireneAliceStates[1], alice.privateKey)],
        alice.privateKey
      )
    )
    await aliceChallengeTx.wait()

    // now the ledger channels are finalized, let's defund the inter channel

    const interChallengeTx = await adjudicator.connect(funding).challenge(
      getFixedPart(interStates[2]),
      interStates[2].turnNum,
      interStates.map(state => getVariablePart(state)),
      0,
      interSigs,
      [0, 1, 2],
      signChallengeMessage(
        [signState(interStates[2], irene.privateKey)],
        irene.privateKey
      )
    )
    await interChallengeTx.wait()

    // now the inter channel has been finalized, lets finalize the alice bob channel

    const bobAliceChallengeTx = await adjudicator.connect(funding).challenge(
      getFixedPart(bobAliceStates[1]),
      bobAliceStates[1].turnNum,
      bobAliceStates.map(state => getVariablePart(state)),
      0,
      bobAliceSigs,
      [0, 1],
      signChallengeMessage(
        [signState(bobAliceStates[1], alice.privateKey)],
        alice.privateKey,
      )
    )
    await bobAliceChallengeTx.wait()

    // now we can execute the relevant claims

    // bob ledger channel
    {
      const bobStart = await bob.getBalance()
      const ireneStart = await irene.getBalance()
      const bobExpected = bobStart.add(baseDepositAmount.sub(depositAmount))
      const ireneExpected = ireneStart.add(baseDepositAmount.sub(depositAmount))
      const bobTransferTx = await adjudicator.connect(funding).transferAllAssets(
        bobChannelId,
        encodeOutcome(ireneBobStates[1].outcome),
        hashState(ireneBobStates[1])
      )
      await bobTransferTx.wait()
      const bobFinal = await bob.getBalance()
      const ireneFinal = await irene.getBalance()
      assert.equal(bobFinal.toString(), bobExpected.toString(), 'Bob ledger withdraw incorrect')
      assert.equal(ireneFinal.toString(), ireneExpected.toString(), 'Irene ledger withdraw incorrect')
    }

    // alice ledger channel
    {
      const aliceStart = await alice.getBalance()
      const ireneStart = await irene.getBalance()
      const aliceExpected = aliceStart.add(baseDepositAmount.sub(depositAmount))
      const ireneExpected = ireneStart.add(baseDepositAmount.sub(depositAmount))
      const aliceTransferTx = await adjudicator.connect(funding).transferAllAssets(
        aliceChannelId,
        encodeOutcome(ireneAliceStates[1].outcome),
        hashState(ireneAliceStates[1])
      )
      await aliceTransferTx.wait()
      const aliceFinal = await alice.getBalance()
      const ireneFinal = await irene.getBalance()
      assert.equal(aliceFinal.toString(), aliceExpected.toString(), 'Alice ledger withdraw incorrect')
      assert.equal(ireneFinal.toString(), ireneExpected.toString(), 'Irene ledger withdraw incorrect')
    }

    // inter channel
    {
      const bobStart = await bob.getBalance()
      const aliceStart = await alice.getBalance()
      const ireneStart = await irene.getBalance()
      const bobExpected = bobStart.add(0)
      const aliceExpected = aliceStart.add(0)
      const ireneExpected = ireneStart.add(depositAmount.mul(2))
      const interTransferTx = await adjudicator.connect(funding).transferAllAssets(
        interChannelId,
        encodeOutcome(interStates[2].outcome),
        hashState(interStates[2])
      )
      await interTransferTx.wait()
      const bobFinal = await bob.getBalance()
      const aliceFinal = await alice.getBalance()
      const ireneFinal = await irene.getBalance()
      assert.equal(bobFinal.toString(), bobExpected.toString(), 'Bob inter withdraw incorrect')
      assert.equal(aliceFinal.toString(), aliceExpected.toString(), 'Alice inter withdraw incorrect')
      assert.equal(ireneFinal.toString(), ireneExpected.toString(), 'Irene inter withdraw incorrect')
    }

    // bob-alice channel
    {
      const bobStart = await bob.getBalance()
      const aliceStart = await alice.getBalance()
      const bobExpected = bobStart.add(bobInterPay)
      const aliceExpected = aliceStart.add(aliceInterPay)
      const bobAliceTransferTx = await adjudicator.connect(funding).transferAllAssets(
        bobAliceChannelId,
        encodeOutcome(bobAliceStates[1].outcome),
        hashState(bobAliceStates[1])
      )
      await bobAliceTransferTx.wait()
      const bobFinal = await bob.getBalance()
      const aliceFinal = await alice.getBalance()
      assert.equal(bobFinal.toString(), bobExpected.toString(), 'Bob withdraw incorrect')
      assert.equal(aliceFinal.toString(), aliceExpected.toString(), 'Alice withdraw incorrect')
    }
  })

  it('should fund a channel between alice and bob offchain', async () => {
    const NitroAdjudicator = await ethers.getContractFactory('NitroAdjudicator')
    const adjudicator = await NitroAdjudicator.deploy()
    await adjudicator.deployed()

    const ForceMoveApp = await ethers.getContractFactory('ForceMoveApp')
    const app = await ForceMoveApp.deploy()
    await app.deployed()

    const [ funding ] = await ethers.getSigners()
    const [ irene, bob, alice ] = [
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
    ].map(wallet => wallet.connect(funding.provider))
    for (const wallet of [irene, bob, alice]) {
      const tx = await funding.sendTransaction({
        to: wallet.address,
        value: ethers.utils.parseEther('1'),
      })
      await tx.wait()
    }

    const {
      channelId: bobChannelId,
      channel: bobChannel,
      outcome: bobOutcome
    } = await createIntermediaryChannel(irene, bob, adjudicator, app)
    const {
      channelId: aliceChannelId,
      channel: aliceChannel,
      outcome: aliceOutcome,
    } = await createIntermediaryChannel(irene, alice, adjudicator, app)

    // now create a 3 person channel. Irene will need to consent to this

    const interChannel = {
      chainId: '0x1234',
      channelNonce: BigNumber.from(0).toHexString(),
      participants: [irene.address, bob.address, alice.address],
    }

    let interSigs = []

    const depositAmount = BigNumber.from(100)
    const startingOutcome = createOutcome([
      {
        address: irene.address,
        amount: depositAmount.mul(2),
      },
      {
        address: bob.address,
        amount: depositAmount,
      },
      {
        address: alice.address,
        amount: depositAmount,
      },
    ], adjudicator)
    const baseState = {
      isFinal: false,
      channel: interChannel,
      outcome: startingOutcome,
      appDefinition: app.address,
      appData: ethers.constants.HashZero,
      challengeDuration: 1,
    }
    const interChannelId = getChannelId(interChannel)
    let whoSignedWhat = [0,1,2]
    interSigs = await signStates([
      {
        ...baseState,
        turnNum: 0,
      },
      {
        ...baseState,
        turnNum: 1,
      },
      {
        ...baseState,
        turnNum: 2,
      }
    ], [irene, bob, alice], whoSignedWhat)
    // now all three have agreed to the inter channel
    // now convince Irene to fund this channel
    // any new outcome that doesn't jeopardise her funds should be fine



    // just the latest two
    let ireneBobSigs = []
    let ireneAliceSigs = []

    const baseDepositAmount = BigNumber.from(1000)
    {
      // update bob channel state
      // bob and alice need to deposit or in order of payment priority for
      // guarantor claims
      const state = {
        isFinal: false,
        channel: bobChannel,
        outcome: createOutcome([
          {
            address: irene.address,
            amount: baseDepositAmount.sub(depositAmount),
          },
          {
            address: bob.address,
            amount: baseDepositAmount.sub(depositAmount),
          },
          {
            address: interChannelId,
            amount: depositAmount.mul(2),
          }
        ], adjudicator),
        appDefinition: app.address,
        appData: ethers.constants.HashZero,
        challengeDuration: 1,
      }
      const state0 = {
        ...state,
        turnNum: 2,
      }
      const state1 = {
        ...state,
        turnNum: 3,
      }
      whoSignedWhat = [0,1]
      ireneBobSigs = await signStates([state0, state1], [irene, bob], whoSignedWhat)
    }
    {
      const state = {
        isFinal: false,
        channel: aliceChannel,
        outcome: createOutcome([
          {
            address: irene.address,
            amount: baseDepositAmount.sub(depositAmount),
          },
          {
            address: alice.address,
            amount: baseDepositAmount.sub(depositAmount),
          },
          {
            address: interChannelId,
            amount: depositAmount.mul(2),
          }
        ], adjudicator),
        appDefinition: app.address,
        appData: ethers.constants.HashZero,
        challengeDuration: 1,
      }
      const state0 = {
        ...state,
        turnNum: 2,
      }
      const state1 = {
        ...state,
        turnNum: 3,
      }
      whoSignedWhat = [0,1]
      ireneAliceSigs = await signStates([state0, state1], [irene, alice], whoSignedWhat)
    }
    // now the inter channel is funded
    // we need a channel just for bob and alice
    const bobAliceChannel = {
      chainId: '0x1234',
      channelNonce: BigNumber.from(0).toHexString(),
      participants: [bob.address, alice.address],
    }
    const bobAliceChannelId = getChannelId(bobAliceChannel)
    const bobAliceOutcome = createOutcome([
      {
        address: bob.address,
        amount: depositAmount,
      },
      {
        address: alice.address,
        amount: depositAmount,
      }
    ], adjudicator)
    const bobAliceState = {
      isFinal: false,
      channel: bobAliceChannel,
      outcome: bobAliceOutcome,
      appDefinition: app.address,
      appData: ethers.constants.HashZero,
      challengeDuration: 1,
    }
    whoSignedWhat = [0,1]
    let bobAliceSigs = await signStates([
      {
        ...bobAliceState,
        turnNum: 0,
      },
      {
        ...bobAliceState,
        turnNum: 1,
      },
    ], [bob, alice], whoSignedWhat)

    // new we set the inter channel to fund the bob alice channel
    const interNextOutcome = createOutcome([
      {
        address: irene.address,
        amount: depositAmount.mul(2),
      },
      {
        address: bob.address,
        amount: BigNumber.from(0),
      },
      {
        address: alice.address,
        amount: BigNumber.from(0),
      },
      {
        address: bobAliceChannelId,
        amount: depositAmount.mul(2),
      },
    ], adjudicator)
    const interNextState = {
      isFinal: false,
      channel: interChannel,
      outcome: interNextOutcome,
      appDefinition: app.address,
      appData: ethers.constants.HashZero,
      challengeDuration: 1,
    }
    whoSignedWhat = [0,1,2]
    interSigs = await signStates([
      {
        ...interNextState,
        turnNum: 3,
      },
      {
        ...interNextState,
        turnNum: 4,
      },
      {
        ...interNextState,
        turnNum: 5,
      }
    ], [irene, bob, alice], whoSignedWhat)

    // now the bob-alice channel is funded
    const aliceInterPay = depositAmount.mul(2).sub(10)
    const bobInterPay = BigNumber.from(10)

    const bobAliceFinalOutcome = createOutcome([
      {
        address: bob.address,
        amount: bobInterPay,
      },
      {
        address: alice.address,
        amount: aliceInterPay,
      }
    ], adjudicator)
    const bobAliceFinalState = {
      isFinal: true,
      channel: bobAliceChannel,
      outcome: bobAliceFinalOutcome,
      appDefinition: app.address,
      appData: ethers.constants.HashZero,
      challengeDuration: 1,
    }
    whoSignedWhat = [0,1]
    bobAliceSigs = await signStates([
      {
        ...bobAliceState,
        turnNum: 2,
      },
      {
        ...bobAliceState,
        turnNum: 3,
      },
    ], [bob, alice], whoSignedWhat)

    // now we have an agreement on how the bob alice channel ends
    // lets propagate it to the inter channel
    // we agree on a new outcome removing the channelId guarantee and updating
    // the balances of participants

    const interFinalOutcome = createOutcome([
      {
        address: irene.address,
        amount: depositAmount.mul(2),
      },
      {
        address: bob.address,
        amount: bobInterPay,
      },
      {
        address: alice.address,
        amount: aliceInterPay,
      },
      // guarantee is removed
    ], adjudicator)
    const interFinalState = {
      isFinal: true,
      channel: interChannel,
      outcome: interFinalOutcome,
      appDefinition: app.address,
      appData: ethers.constants.HashZero,
      challengeDuration: 1,
    }

    // now we update the ledger channels transfer funds to/from irene
    // if we pay alice and receive payment from bob we are the intermediary

    const finalBobStates = []

    {
      // start with bob (order doesn't matter)
      // because bob lost money he will pay irene (who will pay alice if she does not claim the guarantee)
      const state = {
        isFinal: true,
        channel: bobChannel,
        outcome: createOutcome([
          {
            address: irene.address,
            amount: baseDepositAmount.add(depositAmount.sub(bobInterPay)),
          },
          {
            address: bob.address,
            amount: baseDepositAmount.sub(depositAmount).add(bobInterPay),
          },
          // removed the inter channel guarantee from _this_ channel
        ], adjudicator),
        appDefinition: app.address,
        appData: ethers.constants.HashZero,
        challengeDuration: 1,
      }
      finalBobStates.push(
        {
          ...state,
          turnNum: 4,
        },
        {
          ...state,
          turnNum: 5,
        }
      )
      whoSignedWhat = [0,1]
      ireneBobSigs = await signStates(finalBobStates, [irene, bob], whoSignedWhat)
    }
    const finalAliceStates = []
    {
      const state = {
        isFinal: true,
        channel: aliceChannel,
        outcome: createOutcome([
          {
            address: irene.address,
            amount: baseDepositAmount.add(depositAmount.sub(aliceInterPay)),
          },
          {
            address: alice.address,
            amount: baseDepositAmount.sub(depositAmount).add(aliceInterPay),
          },
          // and remove the guarantee
        ], adjudicator),
        appDefinition: app.address,
        appData: ethers.constants.HashZero,
        challengeDuration: 1,
      }
      finalAliceStates.push(
        {
          ...state,
          turnNum: 4,
        },
        {
          ...state,
          turnNum: 5,
        }
      )
      whoSignedWhat = [0,1]
      ireneAliceSigs = await signStates(finalAliceStates, [irene, alice], whoSignedWhat)
    }
    // for verifying after concluding transactions
    const startIreneBalance = await irene.getBalance()
    const expectedIreneBalance = startIreneBalance.add(baseDepositAmount).add(baseDepositAmount)
    const startBobBalance = await bob.getBalance()
    const expectedBobBalance = startBobBalance.add(baseDepositAmount).sub(depositAmount).add(bobInterPay)
    const startAliceBalance = await alice.getBalance()
    const expectedAliceBalance = startAliceBalance.add(baseDepositAmount).sub(depositAmount).add(aliceInterPay)

    // now the ledger channels are finalized, let's withdraw
    // anyone can send this
    const bobFinalTx = await adjudicator.connect(funding).concludeAndTransferAllAssets(
      5,
      getFixedPart(finalBobStates[1]),
      hashAppPart(finalBobStates[1]),
      encodeOutcome(finalBobStates[1].outcome),
      2,
      [0, 1],
      ireneBobSigs,
    )
    await bobFinalTx.wait()

    const aliceFinalTx = await adjudicator.connect(funding).concludeAndTransferAllAssets(
      5,
      getFixedPart(finalAliceStates[1]),
      hashAppPart(finalAliceStates[1]),
      encodeOutcome(finalAliceStates[1].outcome),
      2,
      [0, 1],
      ireneAliceSigs,
    )
    await aliceFinalTx.wait()
    const ireneFinalBalance = await irene.getBalance()
    const bobFinalBalance = await bob.getBalance()
    const aliceFinalBalance = await alice.getBalance()
    assert.equal(ireneFinalBalance.toString(), expectedIreneBalance.toString(), 'Irene balance is incorrect')
    assert.equal(bobFinalBalance.toString(), expectedBobBalance.toString(), 'Bob balance is incorrect')
    assert.equal(aliceFinalBalance.toString(), expectedAliceBalance.toString(), 'Alice balance is incorrect')
    // TODO sad path finalization
  })
})
