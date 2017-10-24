function createStore(state = {}, middlewares = (x) => x) {
  effects = {}
  coeffects = {}
  actions = {}
  listeners = []

  return {
    registerEffect: (id, f) => effects[id] = f,

    registerCoeffect: (id, f) => coeffects[id] = f,

    registerAction: (id, f) => actions[id] = f,

    dispatch(action) {
      const action$ = actions[action[0]](middlewares(action), { ...coeffects, state })

      if (action$.state) {
        // update state
        state = { ...state, ...action$.state }
        // notify subscribers
        Object.keys(listeners).forEach((listener) => listener())
      }
      // run effects
      Object.keys(action$)
        .filter((id) => id !== 'state')
        .filter((id) => !!effects[id])
        .forEach((id) => effects[id](action$[id], { ...effects, dispatch: this }))
    },

    getState: () => state,

    subscribe(listener) {
      listeners.push(listener)
      return () => listeners.filter(($listener) => $listener === listener)
    }
  }
}

const middleware = {
  removeType: ([, ...action]) => action,
  // TODO
  log: (x) => x,
}

////

const fs = require('fs')
const uuid = require('uuid/v4')
const fetch = require('node-fetch')
const { composableFetch, pipeP, delay, delays } = require('composable-fetch')

const fetchJSON = (onRetry) => pipeP(
  composableFetch.withBaseUrl('https://honzabrecka.com/api'),
  composableFetch.withHeader('Content-Type', 'application/json'),
  composableFetch.withHeader('Accept', 'application/json'),
  composableFetch.withEncodedBody(JSON.stringify),
  composableFetch.retryable(composableFetch.fetch1(fetch)),
  composableFetch.withTimeout(1000),
  composableFetch.withRetry(5, (i) => {
    const time = 1000
    onRetry(i, i * i * time)
    return delays.limited(5, delays.exponential(time))(i)
  }),
  composableFetch.withSafe204(),
  composableFetch.decodeResponse,
  composableFetch.checkStatus,
)

const localStorage = {
  read: (key) => JSON.parse(fs.readFileSync(`./${key}.data`)),
  write: (key, value) => fs.writeFileSync(`./${key}.data`, JSON.stringify(value))
}

const addToBatch = (batch, id, v) => {
  return batch[id]
    ? { ...batch, [id]: [...batch[id], v] }
    : { ...batch, [id]: v }
}

const persistFetchQueues = (action) => {
  if (action.state && action.state.pendingQueue)
    action.batch = addToBatch(action.batch, 'pendingQueue', action.state.pendingQueue)

  if (action.state && action.state.waitingQueue)
    action.batch = addToBatch(action.batch, 'waitingQueue', action.state.waitingQueue)

  return action
}

const store = createStore(pipeP(
  persistFetchQueues,
  middleware.removeType,
))

store.registerCoeffect('localStorage', (key) => {
  return localStorage.read(key)
})

store.registerEffect('localStorage', ([key, value]) => {
  localStorage.write(key, value)
})

store.registerCoeffect('uuid', uuid)

store.registerEffect('fetch', async (req, { dispatch }) => {
  try {
    const { onSuccess, onError, onRetry } = req
    delete req.onSuccess
    delete req.onError
    delete req.onRetry
    const onRetry$ = (i, delay) => dispatch([...onRetry || ['GLOBAL_RETRY'], i, delay])
    const res = await fetchJSON(onRetry$)(req)
    dispatch([...onSuccess, res])
  } catch (e) {
    dispatch([...onError || ['GLOBAL_ERROR'], e])
  }
})

store.registerEffect('batch', (batch, effects) => {
  Object.keys(batch)
    .filter((id) => !!effects[id])
    .forEach((id) => {
      batch[id].forEach((v) => {
        effects[id](v, effects)
      })
    })
})

store.registerAction('REVIVE', (_, { localStorage }) => {
  const pendingQueue = localStorage('pandingQueue')
  const waitingQueue = localStorage('waitingQueue')

  return {
    state: { pendingQueue, waitingQueue },
    batch: { fetch: [...pendingQueue, ...waitingQueue] }
  }
})

store.registerAction('LOGIN', ([credentials]) => ({
  fetch: {
    url: '/login',
    method: 'post',
    body: credentials,
    onSuccess: ['LOGIN_SUCCESS']
  }
}))

store.registerAction('LOGIN_SUCCESS', ([{ token }]) => ({
  localStorage: ['token', token]
}))

store.registerAction('PROFILE', ([id], { state, localStorage, uuid }) => {
  const reqId = uuid()
  const fetch = {
    fetch: {
      url: '/profile/' + id,
      headers: { authorization: localStorage('token') },
      onSuccess: ['PROFILE_SUCCESS', id, reqId],
      onError: ['PROFILE_ERROR', id, reqId],
      reqId
    }
  }

  return {
    fetch,
    state: {
      pendingQueue: [...state.pendingQueue, fetch]
    }
  }
})

store.registerAction('PROFILE_SUCCESS', ([, reqId$, data], { state }) => ({
  state: {
    profile: data,
    pendingQueue: state.pendingQueue.filter(({ reqId }) => reqId !== reqId$)
  }
}))

store.registerAction('PROFILE_ERROR', ([, reqId$, error], { state }) => {
  if (error.res.status === 401) {
    const { pendingQueue, waitingQueue } = state

    return {
      fetch: {
        url: '/token',
        onSuccess: ['TOKEN_SUCCESS']
      },
      state: {
        pendingQueue: pendingQueue.filter(({ reqId }) => reqId !== reqId$),
        waitingQueue: [...waitingQueue, pendingQueue.filter(({ reqId }) => reqId === reqId$)[0]]
      }
    }
  }

  return { state: { globalError: error.message } }
})

store.registerAction('TOKEN_SUCCESS', ([{ token }], { state }) => ({
  localStorage: ['token', token],
  batch: { fetch: [...state.waitingQueue, ...state.pendingQueue] }
}))

store.registerAction('GLOBAL_ERROR', ([error]) => ({
  state: { globalError: error.message }
}))

store.dispatch(['REVIVE'])
store.dispatch(['LOGIN'])
store.dispatch(['PROFILE', 7654])
store.dispatch(['PROFILE', 7897])
store.dispatch(['PROFILE', 2345])
