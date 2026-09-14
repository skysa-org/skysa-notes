A fence with a language:

```ts
const provider: StorageProvider = createDropbox(token)
await provider.ensureRoot()
```

A fence with no language:

```
plain text
```

A fence containing backticks:

````md
```js
nested()
```
````

An indented code block, which the serializer rewrites as a fence:

    indented block
    second line
