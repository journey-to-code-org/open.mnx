<script setup lang="ts">
import { ref } from 'vue';
import Rating from '../components/rating.zb';
import Card from '../components/card.zb';

const stars = ref(1);
const items = ref(['a', 'b']);
const log = ref<string[]>([]);
Object.assign(window, { setItems: (next: string[]) => { items.value = next; } });
</script>

<template>
  <Rating v-model="stars" @change="log.push('change')" />
  <p id="stars">{{ stars }}</p>
  <Card heading="Vue">
    <template #title><h2>Custom</h2></template>
    <p v-for="item in items" :key="item">{{ item }}</p>
  </Card>
  <p id="log">{{ log.join(',') }}</p>
</template>
