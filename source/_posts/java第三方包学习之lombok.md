---
title: java第三方包学习之lombok
tags:
  - java
categories: quick-start
index_img: /images/java.jpg
abbrlink: 38f80316
date: 2016-07-16 01:09:49
---
**Laziness is a virtue！**每当写pojo类时，都会重复写一些setter/getter/toString等大量的模版代码，无聊繁琐又不得不做，这会让这个类变得又臭又长，却没有多少东西。不久前发现有一个java第三方库可以一定程度上帮助我们从体力劳动中解救出来，它就是lombok。它提供了一些简单的注解，并以此来消除java中臃肿的模版代码。本文对于一些常用到的注解做了一个简要的记录，希望有更多的人enjoy it！
<!--more-->
## Lombok是什么
Lombok是一个旨在减少代码开发工作的Java库。它提供了一些简单的注解，并以此来消除java中臃肿的模版代码，比如 pojo 中最常见的 setter/getter 方法， 比如 toString 方法， 比如 equals 方法等等，还可以帮助我们关闭流，即使 JDK7 中已经有了 TWR 特性，但这个包很值得一试。
通过几个简单的注解，将模版代码在编译时写入程序。使用 eclipse 可以在 Outline 窗口看到生成的方法，但是在源码里是干净的，

## 安装
首先去 lombok 的[官网](http://projectlombok.org/)下载一个 jar 包。
只是把 jar 包下载下来并导入工程中，不会发现 IDE 不识别它的注解，那怎么办？
### 对于eclipse
将 lombok.jar 复制到 eclipse.ini 所在的目录下，然后编辑 eclipse.ini 文件， 在它的最后面插入以下两行并保存：

```othe
­Xbootclasspath/a:lombok.jar
­javaagent:lombok.jar
```
接着重启 eclipse 就可以愉快地使用这个库了。

### 对于 IDEA
在 IntelliJ 的插件中心可以找到它。

## QuickStart
Lombok 提供的注解不多，但都好用，简要说一下常用的几个。
### @Setter/@Getter
这两个注解修饰成员变量，可用于生成 setter/gettter 模版代码。
举个栗子：

```java
import lombok.AccessLevel;
import lombok.Getter;
import lombok.Setter;

public class Student {
    @Setter @Getter private String name;
    @Getter(AccessLevel.PROTECTED) private int age;// 可以指定访问权限
    @Setter @Getter private String[] hobbies;
}
```
将字节码文件反编译后可以看到下面这段代码

```java
public class Student {
  private String name;
  private int age;
  private String[] hobbies;

  public String getName() { return this.name; }
  public void setName(String name) { this.name = name; }

  protected int getAge() { return this.age; }
  public String[] getHobbies() { return this.hobbies; }
  public void setHobbies(String[] hobbies) { this.hobbies = hobbies; }
}
```
### @ToString

```java
import lombok.ToString;

@ToString(exclude="id")
public class ToStringExample {
    private int id;
    private String name;
    private String[] tags;
}
```
编译后

```java
import java.util.Arrays;

public class ToStringExample {
  public String toString() {
    return "ToStringExample(name=" + this.name + ", tags=" + Arrays.deepToString(this.tags) + ")";
    }

  private int id;
  private String name;
  private String[] tags;
}
```
我们发现，对于数组，在写 toString 方法时使用了 Arrays类的 静态方法 deepToString。
来看 eclipse 自动生成的 toString 方法：

```java
@Override
public String toString() {
    return "ToStringExample [name=" + name + ", tags="
        + Arrays.toString(tags) + "]";
}
```
eclipse 中对于数组采用的是 Arrays.toString()。
**区别**：这两个方法的区别是这样的，对于多维数组，使用 toString 只能打印出内部数组的名字，这时需要使用 deepToString 方法，它能将内部数组的内容全部打印出来。

#### exclude 参数
可以指定哪些属性不出现在 toString 方法中， 比如 **exclude={"id", "name"}**
#### doNotUseGetters 参数
当类中有成员变量的 getter 方法时，生成 toString 方法会使用这些 getter 方法，比如

```java
public String toString() {
    return "ToStringExample(name=" + getName() + ", tags=" + Arrays.deepToString(getTags()) + ")";
    }
```
但是将该参数设置为 true 时（默认为 false），生成 toString 方法时就不会使用 getter 方法，而是直接使用这些成员变量，比如

``` java
public String toString() {
    return "ToStringExample(name=" + this.name + ", tags=" + Arrays.deepToString(this.tags) + ")";
    }
```
#### includeFieldNames参数
原本是以 **fieldName = fieldValue** 的格式来生成 toString 方法的，但是将该参数设置为 false 后（默认是 true），就不会显示 fieldName 了，而只是生成 fieldValue， 比如

```java
public String toString() {
  return "ToStringExample(" + getId() + ", " + getName() + ", " + Arrays.deepToString(getTags()) + ")";
  }
```
#### callSuper 参数
若类 A 是类 B 的子类，那么在 A 类重写 toString 时，若把该参数设置为 true，会加入下面这段代码，即也会把父类 B 的 toString 也写入。
```java
super=" + super.toString()
```

### @NonNull
检查传入对象是否为 Null，若为null，则抛出NullPointerException异常。
举个栗子

```java
import lombok.NonNull;
public class NonNullExample extends Student{
    private String name;
    public NonNullExample(@NonNull Student student) {
        this.name = student.getName();
    }
}
```
编译后代码

```java
import lombok.NonNull;
public class NonNullExample extends Student {
    private String name;

    public NonNullExample(@NonNull Student student) {
        if (student == null)
            throw new NullPointerException("student");
        this.name = student.getName();
  }
}
```

### @EqualsAndHashCode
用在类上，用于生成 equals 和 hashcode 方法。
举个栗子

```java
@EqualsAndHashCode(exclude={"id"})
public class EqualsAndHashCodeExample {
     private transient int transientVar = 10;
     private String name;
     private double score;
     private String[] tags;
     private int id;
}
```
编译后代码

```java
import java.util.Arrays;

public class EqualsAndHashCodeExample {
    public int hashCode() {
        int PRIME = 59;
        int result = 1;
        Object $name = this.name;
        result = result * 59 + ($name == null ? 43 : $name.hashCode());
        long $score = Double.doubleToLongBits(this.score);
        result = result * 59 + (int)($score ^ $score >>> 32);
        result = result * 59 + Arrays.deepHashCode(this.tags);
        return result;
    }
    protected boolean canEqual(Object other) {
        return other instanceof EqualsAndHashCodeExample;
    }
    public boolean equals(Object o) {
        if (o == this)  return true;
        if (!(o instanceof EqualsAndHashCodeExample)) return false;
        EqualsAndHashCodeExample other = (EqualsAndHashCodeExample)o;
        if (!other.canEqual(this)) return false;
        Object this$name = this.name;
        Object other$name = other.name;
        if (this$name == null ? other$name != null : !this$name.equals(other$name))                     return false;
        if (Double.compare(this.score, other.score) != 0)
            return false;
        return Arrays.deepEquals(this.tags, other.tags);
    }

    private transient int transientVar = 10;
    private String name;
    private double score;
    private String[] tags;
    private int id;
}
```
可以看出transient修饰的变量，不会参与。
#### 参数
参数 of 用来指定参与的变量，其他的跟 **@ToString** 注解类似。

### @Data
该注解用于修饰类，会自动生成getter/setter方法, 以及重写equals(), hashcode()和toString()方法。

### @Cleanup
该注解可以用来自动管理资源，用在局部变量之前，在当前变量范围内即将执行完毕退出之前会自动清理资源， 自动生成try­finally这样的代码来**关闭流**。
举个栗子，

```java
import lombok.Cleanup;
import java.io.*;

public class CleanupExample {
  public static void main(String[] args) throws IOException {
    @Cleanup InputStream in = new FileInputStream(args[0]);
      @Cleanup OutputStream out = new FileOutputStream(args[1]);
        byte[] b = new byte[10000];
        while (true) {
        int r = in.read(b);
        if (r == -1) break;
        out.write(b, 0, r);
       }
     }
  }
```
### @NoArgsConstructor/@RequiredArgsConstructor/@AllArgsConstructor
这三个注解修饰在类上。
@NoArgsConstructor 用于生成一个无参构造方法。
@RequiredArgsConstructor 会生成一个包含了被@NotNull标识的变量的构造方法。同样可以设置生成构造方法的权限，使用 **access**参数进行设置。若指定staticNam
e = “of”参数，同时还会生成一个返回类对象的静态工厂方法，生成的构造方法是私有的。
@AllArgsConstructor 会生成一个包含所有变量， 同时如果变量使用了**@NotNull**，会进行是否为空的校验。
举个栗子，

```java
import lombok.*;

@RequiredArgsConstructor(staticName = "of")
@AllArgsConstructor(access = AccessLevel.PROTECTED)
public class ConstructorExample {
    private int x;
    private int y;
    @NonNull private String desc;

    @NoArgsConstructor
    public class NoArgsExample{
        private String field;
    }

}
```
这与下面这段代码是等价的，

```java
import java.beans.ConstructorProperties;

public class ConstructorExample {
    public static ConstructorExample of(@lombok.NonNull String desc) {
        return new ConstructorExample(desc);
    }
    private ConstructorExample(@lombok.NonNull String desc) {
        if (desc == null) throw new NullPointerException("desc");
        this.desc = desc;
    }
    @ConstructorProperties({"x", "y", "desc"})
    protected ConstructorExample(int x, int y, @lombok.NonNull String desc) {
        if (desc == null) throw new NullPointerException("desc");
        this.x = x;
        this.y = y;
        this.desc = desc;
    }

    private int x;
    private int y;
    @lombok.NonNull
    private String desc;
    public class NoArgsExample
    {
        private String field;
        public NoArgsExample() {}
    }
}

```
### @Value
该注解用于修饰类，是**@Data**的不可变形式， 相当于为成员变量添加**final**声明， 只提供getter方法， 而不提供setter方法，
然后还有 equals/hashCode/toString方法，以及一个包含所有参数的构造方法。

### @Builder
用在类、构造器、方法上，为你提供复杂的builder APIs，让你可以像如下方式调用Person.builder().name("A
dam Savage").city("San Francisco").job("Mythbusters").job("Unchained Reaction").build()。
举个栗子，

```java
import lombok.Builder;
import java.util.Set;

@Builder
public class BuilderExample {
    private String name;
    private int age;
}
```
反编译代码如下：

```java

package tutorial.lombok;

public class BuilderExample
{
    public static class BuilderExampleBuilder
    {

        private String name;
        private int age;

        public BuilderExampleBuilder name(String name)
        {
            this.name = name;
            return this;
        }

        public BuilderExampleBuilder age(int age)
        {
            this.age = age;
            return this;
        }

        public BuilderExample build()
        {
            return new BuilderExample(name, age);
        }

        public String toString()
        {
            return (new StringBuilder()).append("BuilderExample.BuilderExampleBuilder(name=").append(name).append(", age=").append(age).append(")").toString();
        }

        BuilderExampleBuilder()
        {
        }
    }


    private String name;
    private int age;

    BuilderExample(String name, int age)
    {
        this.name = name;
        this.age = age;
    }

    public static BuilderExampleBuilder builder()
    {
        return new BuilderExampleBuilder();
    }
}
```
注意：使用@Singular注解的集合属性名必须使用s结尾, lombok会将属性名结尾的s去掉,剩余的名字会作为方法名, 向这个集合中添加元素。
@Builder 的参数builderClassName设置生成的builder方法名，buildMethodName 设置build方法名，builderMethodName设置builderMethod方法名。
比如,**@Builder(builderClassName = "GBuilder", buildMethodName = "buildG", builderMethodName = "GBuilder"**

### @SneakyThrows
自动抛受检异常， 而无需显式在方法上使用throws语句。

### @Synchronized
用在方法上，将方法声明为同步的，并自动加锁，而锁对象是一个私有的属性 LOCK，而java中的synchronized关键字锁对象是this，锁在this或者自己的类对象上存在副作用，就是你不能阻止非受控代码去锁this或者类对象，这可能会导致竞争条件或者其它线程错误。
举个栗子，

```java
import lombok. Synchronized;

public class SynchronizedExample {
    private final Object readLock = new Object() ;
    @Synchronized
    public static void hello() {
        System. out. println("world") ;
    }

    @Synchronized("readLock")
    public void foo() {
        System. out. println("bar") ;
    }
}
```
反编译代码如下：

```java
public class SynchronizedExample {
    private static final Object $LOCK = new Object[0] ;
    private final Object readLock = new Object() ;
    public static void hello() {
        synchronized($LOCK) {
            System. out. println("world") ;
        }
    }
    public int answerToLife() {
        synchronized($lock) {
            return 42;
        }
    }
    public void foo() {
        synchronized(readLock) {
            System. out. println("bar") ;
        }
    }
}
```

### @Getter(lazy=true)
可以替代经典的Double Check Lock样板代码。
举个栗子，

```java
import lombok.Getter;

public class GetterLazyExample {
    @Getter(lazy=true) private final double[] cached = expensive();

    private double[] expensive() {
        double[] result = new double[1000000];
        for (int i = 0; i < result.length; i++) {
            result[i] = Math.asin(i);
        }
        return result;
    }
}
```
反编译代码如下，

```java
import java.util.concurrent.atomic.AtomicReference;

public class GetterLazyExample
{

    private final AtomicReference cached = new AtomicReference();

    public GetterLazyExample()
    {
    }

    private double[] expensive()
    {
            double result[] = new double[0xf4240];
        for (int i = 0; i < result.length; i++)
            result[i] = Math.asin(i);

        return result;
    }

    public double[] getCached()
    {
        Object value = cached.get();
        if (value == null)
            synchronized (cached)
            {
                value = cached.get();
                if (value == null)
                {
                    double actualValue[] = expensive();
                    value = actualValue != null ? ((Object) (actualValue)) : ((Object) (cached));
                    cached.set(value);
                }
            }
        return (double[])(double[])(value != cached ? value : null);
    }
}
```
### @Log
根据不同的注解生成不同类型的log对象， 但是实例名称都是log， 有六种可选实现类

```java
@CommonsLog
Creates log = org. apache. commons. logging. LogFactory. getLog(LogExample. class) ;
@Log
Creates log = java. util. logging. Logger. getLogger(LogExample. class. getName() ) ;
@Log4j
Creates log = org. apache. log4j. Logger. getLogger(LogExample. class) ;
@Log4j2
Creates log = org. apache. logging. log4j. LogManager. getLogger(LogExample. class) ;
@Slf4j
Creates log = org. slf4j. LoggerFactory. getLogger(LogExample. class) ;
@XSlf4j
Creates log = org. slf4j. ext. XLoggerFactory. getXLogger(LogExample. class) ;
```
举个栗子，

```java
import lombok.extern.java.Log;
import lombok.extern.slf4j.Slf4j;
@Log
public class LogExample {
    public static void main(String... args) {
        log.error("Something's wrong here");
    }
}

@Slf4j
public class LogExampleOther {
    public static void main(String... args) {
        log.error("Something else is wrong here");
    }
}

@CommonsLog(topic="CounterLog")
public class LogExampleCategory {
    public static void main(String... args) {
        log.error("Calling the 'CounterLog' with a message");
    }
}
```

```
@CommonsLog(topic="CounterLog")
```
这条语句会翻译成这样

```java
private static final org.apache.commons.logging.Log log = org.apache.commons.logging.LogFactory.getLog("CounterLog");
```
