<script setup>
import { ref } from 'vue';
// Imported into Vue, a component is a Vue component: v-model:count binds its two-way prop.
import HelloCounter from './components/hello-counter.mnx';

const count = ref(0);
</script>

<template>
  <main>
    <h1>{{title}}</h1>
    <HelloCounter v-model:count="count" label="Clicks" />
    <p>Vue sees <span id="seen">{{ count }}</span></p>
  </main>
</template>
