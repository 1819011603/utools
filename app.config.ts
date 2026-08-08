export default defineAppConfig({
  ui: {
    // 主色用 rose 而不是 pink：同样是暖色系，rose 更沉一点，
    // 大面积铺开时不会甜腻——「氛围感」靠的是低饱和的底色和留白，不是把颜色调重
    primary: 'rose',
    gray: 'zinc',
    notifications: {
      position: 'top-4 end-4 bottom-[unset]'
    }
  }
})
