const TendermintLightClient = artifacts.require('TendermintLightClient')
const IBCHandler = artifacts.require('IBCHandler')
const IBCHost = artifacts.require('IBCHost')
const protobuf = require('protobufjs')

contract('TendermintLightClient', () => {
  it('verifies ingestion of valid continuous headers', async () => {
      await ingest(8557448, 8557449)
      //await ingest(28, 29)
  })

  //it('verifies ingestion of valid non-continuous headers', async () => {
      //await ingest(28, 30)
  //})
})

async function ingest(h1, h2) {
    const root = new protobuf.Root()
    let Any

    await root.load('test/data/any.proto', { keepCase: true }).then(async function (root, err) {
      if (err) {
        throw err
      }

      Any = root.lookupType('Any')
    })

    await root.load('./proto/TendermintLight.proto', { keepCase: true }).then(async function (root, err) {
      if (err) { throw err }

      // types
      const ClientState = root.lookupType('tendermint.light.ClientState')
      const ConsensusState = root.lookupType('tendermint.light.ConsensusState')
      const ValidatorSet = root.lookupType('tendermint.light.ValidatorSet')
      const SignedHeader = root.lookupType('tendermint.light.SignedHeader')
      const TmHeader = root.lookupType('tendermint.light.TmHeader')
      const Fraction = root.lookupType('tendermint.light.Fraction')
      const Duration = root.lookupType('tendermint.light.Duration')

      // core structs
      const validatorSetObj = require('./data/header.' + h1 + '.validator_set.json')
      const vs = ValidatorSet.fromObject(validatorSetObj)

      const headerObj = require('./data/header.' + h1 + '.signed_header.json')
      const sh = SignedHeader.fromObject(headerObj)

      // args
      const clientStateObj = ClientState.create({
        chain_id: sh.header.chain_id,
        trust_level: Fraction.create({
          numerator: 1,
          denominator: 3
        }),
        trusting_period: Duration.create({
          seconds: 100000000000,
          nanos: 0
        }),
        unbonding_period: Duration.create({
          seconds: 100000000000,
          nanos: 0
        }),
        max_clock_drift: Duration.create({
          seconds: 100000000000,
          nanos: 0
        }),
        frozen_height: 0,
        latest_height: sh.header.height,
        allow_update_after_expiry: true,
        allow_update_after_misbehaviour: true
      })

      const consensusStateObj = ConsensusState.create({
        root: sh.header.app_hash,
        timestamp: sh.header.time,
        next_validators_hash: sh.header.next_validators_hash
      })

      // encoded args
      const encodedClientState = await Any.encode(Any.create({
        value: await ClientState.encode(clientStateObj).finish(),
        type_url: '/tendermint.types.ClientState'
      })).finish()

      const encodedConsensusState = await Any.encode(Any.create({
        value: await ConsensusState.encode(consensusStateObj).finish(),
        type_url: '/tendermint.types.ConsensusState'
      })).finish()

      // contracts
      const tlc = await TendermintLightClient.deployed()
      const handler = await IBCHandler.deployed()
      const host = await IBCHost.deployed()

      // step 1: register client
      try {
        await handler.registerClient.call('07-tendermint', tlc.address)
      } catch (error) {
        if (!error.message.includes('clientImpl already exists')) {
          throw error
        }
      }

      // step 2: create client
      await call(async () => {
        return await handler.createClient({
          clientType: '07-tendermint',
          height: sh.header.height.low,
          clientStateBytes: encodedClientState,
          consensusStateBytes: encodedConsensusState
        })
      }, "failed to call createClient");

      // step 3: get client id
      const events = await host.getPastEvents('GeneratedClientIdentifier')
      const clientId = events[events.length - 1].returnValues['0']

      // step 4: update client
      const secondHeaderObj = require('./data/header.' + h2 + '.signed_header.json')
      const ssh = SignedHeader.fromObject(secondHeaderObj)

      const secondValidatorSetObj = require('./data/header.' + h2 + '.validator_set.json')
      const svs = ValidatorSet.fromObject(secondValidatorSetObj)
      const tmHeader = TmHeader.create({
        signed_header: ssh,
        validator_set: svs,

        trusted_height: sh.header.height.low,
        //trusted_validators: vs
      })

      const all = Any.create({
        value: await TmHeader.encode(tmHeader).finish(),
        type_url: '/tendermint.types.TmHeader'
      })
      const allSerialized = await Any.encode(all).finish()

      await call(async () => {
        return await handler.updateClient({
          clientId: clientId,
          header: allSerialized
        });
      }, "failed to call updateClient");
    })
}

async function call(fn, errMsg) {
      try {
        const tx = await fn()
        console.log(tx)
      } catch (error) {
        console.log(errMsg)
        const tx = await web3.eth.getTransaction(error.tx)
        await web3.eth.call(tx)
      }
}
